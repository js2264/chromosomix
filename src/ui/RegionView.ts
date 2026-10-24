/**
 * The region view (spec §5.4): a `contig` or `contig:start-end` selection.
 *
 * Range parsing is not done here — it is delegated to the reader so that the
 * browser and `parse_metacooler_range` agree exactly, including the refusals:
 *
 * 1. a **genome name** expands to the whole-genome extent, and a coordinate
 *    suffix on a genome name is an *error*, not something quietly ignored;
 * 2. otherwise a **contig**, optionally with coordinates — the region string
 *    handed over is cooler's, 0-based and half-open, verified against
 *    `parse_region`;
 * 3. neither → an error listing the available genomes and contigs.
 *
 * **What is on screen is the display form, though** (§26.1): the heading, the
 * locus box and the zoom steps' tooltips print `regionLabel` — 1-based
 * inclusive, digits grouped, as IGV, UCSC and samtools print a locus — and what
 * is typed is read back through `typedLocusToRegion` before it becomes that
 * region string — two of them, `typedLociToRegions`, for a block of two windows
 * typed as one. Both lines used to print the region string itself, so the
 * heading and the summary immediately under it named one window at two starts a
 * base apart, and copying a coordinate out of one and into the box moved the
 * picture by a base. The conversion sits at the box rather than on the reader:
 * pressing Enter on the value the box is already showing must change nothing.
 *
 * Genome and contig namespaces can collide and genome wins, as in Python, so
 * the view states which kind the search matched rather than leaving the user to
 * infer it from the picture.
 *
 * With a second region set, the block is the **rectangle between two contigs**
 * rather than one contig's square. That is what clicking the intersection of two
 * contigs in a genome view asks for, and the two axes are independent: the row
 * range and the column range are resolved separately and the reader handles the
 * transpose when the column range precedes the row range in bin space (§5.3).
 */

import type { ParsedRange } from '../types'
import { devFeature } from '../state/devFeatures'
import type { MatrixResult } from '../worker/protocol'
import { formatRegion, parseRegion } from '../annotations/bookmarks'
import { pairLabel, regionLabel, typedLociToRegions } from '../genome/assembly'
import { ViewerError } from '../errors'
import type { ReaderClient } from '../worker/client'
import { button, el, titleWhenCut } from './dom'
import type { PanelSeed, ScaleState } from './GenomeView'
import {
  MatrixPanel,
  type AnnotationContext,
  type CircularPresentation,
  type DerivePresentation,
  type FramedRegion,
  type TurnPresentation,
 type FigureSubject} from './MatrixPanel'
import { axisRegion } from './mapSelection'
import { blockSummary } from './mapSummary'
import { icon, iconButton } from './icons'
import { presentationOf, secondBlock, type CompareRead, type LowerRead } from './compare'
import type { LowerPresentation } from './LowerReading'
import { attachRefine, poolingRung, rungsOf, type BlockLadder } from './refine'
import { scoreChoices, scoreFor, type ScoreChoice } from './scores'
import { SearchBox, featureSuggestions, locusPlaceholder } from './SearchBox'
import { stepper } from './Stepper'

export interface RegionViewProps {
  client: ReaderClient
  binsize: number
  /** Sibling rungs of a laddered file (§3.4); absent for a plain one. */
  rungs?: readonly string[]
  /**
   * Bins of this map summed into one drawn cell, because the reader asked for a
   * resolution the file does not store (§3.4).
   *
   * The factor, not the bin size: a 10 kb rung derived from a 2 kb map is `5`,
   * and the effective resolution on screen is this map's bin size times it. The
   * base rung is the map that is *open* — picking a derived resolution navigates
   * to it — so every read here is an ordinary one carrying an explicit plan,
   * and the worker snaps that plan to each sequence's own grid so the cells hold
   * the same sums wherever the reader pans (`worker/reader.worker.ts`).
   *
   * Absent, or 1, is every view of every file until somebody adds one.
   */
  binsPerCell?: number
  /**
   * A control the session puts on the title line, after the box.
   *
   * The 1D/2D switch, today. An element rather than a callback because what
   * it says depends on which of the two pictures is on screen, and only the
   * session knows that — see `Session.mapToggleButton`.
   */
  extraControl?: HTMLElement
  region: string
  /** Column-axis region; when set the block is rectangular, not square. */
  region2?: string
  /**
   * A stretch of {@link region} to open zoomed to, on the diagonal — a bookmark's
   * "take me there" (§8.10, `ViewState.focus`).
   *
   * A window over the block this view reads, *not* a narrower block: the region
   * is still whatever was asked for, so the reader can pan out of the window into
   * the rest of it. Which is why it is a prop of this view rather than a
   * coordinate suffix on {@link region} — the two say different things about what
   * is read, and only one of them can be panned out of.
   */
  focus?: string
  /**
   * A control the session puts on the title line, after `go`.
   *
   * *Take a bookmark of what is on screen*, today. Separate from
   * {@link extraControl} because the two belong at opposite ends of the bar: this
   * one acts on the box's own subject and sits beside it, and that one switches
   * which picture the whole view is of.
   */
  boxControl?: HTMLElement
  scale: PanelSeed
  balance: boolean
  /** Whether the file carries a weight column at all. */
  hasWeights: boolean
  /**
   * The `/pixels` column the reads take; `count` when absent.
   *
   * Resolved by the session rather than derived here from {@link score}, so the
   * fallback for a hash naming a column this file does not have is decided in
   * one place — see `Session.valueOf`.
   */
  value?: string
  /** Value columns this file carries, for the score picker (`ui/scores.ts`). */
  scoreColumns?: readonly string[]
  /**
   * Whether the window is on one sequence declared circular, along whose two
   * arms the score picker then offers the baseline (§8.15). Told again through
   * the panel when a tick moves under the view.
   */
  circle?: boolean
  /** The picker's current choice, by id; `count` when absent. */
  score?: string
  /** What one sequence is called here: a contig, or a chromosome. */
  noun: string
  onScoreChange(choice: ScoreChoice): void
  /**
   * The derived-values presentation (`render/derive.ts`), built by the session.
   *
   * Passed through rather than assembled here: four views mount the same panel,
   * and a default decided in each is a default that comes to differ.
   */
  derive?: DerivePresentation
  /** The 45° turn (`render/rotate.ts`), built by the session like `derive`. */
  turn?: TurnPresentation
  /**
   * A new selection. The second region makes the block rectangular — the
   * contacts *between* two contigs rather than within one (§5.3).
   */
  /**
   * Open another block. `focus`, where given, is a window of it to open
   * framed on (§8.10's bookmark gesture) — a searched gene, read with context.
   */
  onChangeRegion(region: string, region2?: string, focus?: string): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  onError(err: unknown): void
  /**
   * Annotations to draw beside and on the map (spec §8).
   *
   * Supplied only for a cooler; a `.metacool` never carries one (§8.5), which is
   * why the genome and pair views — reachable only on files that *have* genomes
   * — do not take this at all.
   */
  annotations?: AnnotationContext
  /**
   * A second cooler in the lower-left triangle (`render/compare.ts`).
   *
   * The same block, read from the other file. The two agree about contigs and
   * bin size — the compare gate is what establishes that — so the extents
   * resolved for this file address the same bins in the other one, and nothing
   * has to be parsed twice.
   */
  compare?: CompareRead
  /**
   * The lower triangle in a reading of its own (§5.10), for the map's second
   * tab; absent beside a second file and in a deck.
   */
  lower?: LowerPresentation
  /**
   * The second read that reading needs where its score is another column or
   * the balancing the other way — the same requests as the first, asked of the
   * same file again (`ui/compare.ts`). Never beside {@link compare}.
   */
  lowerRead?: LowerRead
  /** File and genome context for the exported figure's caption. */
  caption?: FigureSubject
  /**
   * Contigs one step away in file order. Absent for a two-contig block, which
   * has two axes and so no single neighbour to step to.
   */
  neighbours?: { prev: string | null; next: string | null }
  onStep?(delta: number): void
  /**
   * *This sequence is circular* (SPECS §8.15) — the reader's declaration.
   *
   * The declaration is made in the Chromosomes table, a column of ticks beside
   * the lengths; this view *reads* it. Absent on a two-contig block, which is
   * two sequences and has no origin to frame across, and on a file the session
   * has no circular store for. When it is present and `on`, a window typed
   * across the origin — or `ori`'s — is a legal region, read **wrapped**: its
   * extent runs off the end of the sequence and is resolved modulo it, and that
   * extent is the ladder's ceiling, so a zoom refines inside the frame and no
   * pan or read goes past it. A window that does not cross the origin is read,
   * panned and zoomed exactly as on a line.
   */
  circular?: CircularPresentation
}

/**
 * How many bins of context a gene picked in the map's box is read with, each
 * side (§5.4): enough to wheel a long way back out of the gene at the file's
 * own bins, and a block small enough to come back at them.
 */
export const SEARCH_CONTEXT_BINS = 100

/**
 * The four steps the zoom buttons take, in the order they sit on the bar.
 *
 * **Widest first, narrowest last**, so the row reads as one ruler rather than as
 * two pairs of controls: every press moves the window along it in the direction
 * the button is on, and a reader who wants *a bit* wider reaches for the one
 * beside the box rather than aiming.
 *
 * Three and ten rather than one factor twice. Three is what a genome browser's
 * zoom button has done since there were genome browsers — a third of the new
 * window is what you were looking at and a third each side is what it sits in —
 * and it is the wrong step when the answer is four chromosomes away. Ten gets
 * there in one press and loses where you were, which is exactly the trade a
 * reader should be able to make per press rather than per application.
 */
export const ZOOM_STEPS: ReadonlyArray<{ factor: number; label: string; out: boolean }> = [
  { factor: 10, label: '10×', out: true },
  { factor: 3, label: '3×', out: true },
  { factor: 1 / 3, label: '3×', out: false },
  { factor: 1 / 10, label: '10×', out: false },
]

/**
 * The window on screen, scaled about its own centre — as a region string.
 *
 * `factor` is **how many times wider the window becomes**: above one widens,
 * below one narrows, and one press of each button is one of {@link ZOOM_STEPS}.
 * One function for both directions because it is one piece of arithmetic, and
 * every interesting case is an edge it shares: a window against the end of a
 * chromosome cannot be centred, and a window one press from the whole sequence
 * has to *become* the whole sequence rather than `chrI:0-230218`.
 *
 * `null` when the press would change nothing, which is what greys the button: a
 * window that already covers the sequence has nowhere wider to go, and one
 * already down to a bin has nowhere finer. `floor` is the bin size where the
 * caller knows it, because a window narrower than one bin is a window of one bin
 * drawn with a coordinate nobody can act on.
 *
 * **On a circle a press stops at the ends, as on a line** (§8.15). The way across
 * the origin is `ori`, which frames the whole circle with the origin in the
 * middle, or a window typed across it — and nothing else. A press outward near
 * an end used to wrap past the origin instead, which made the zoom steps a third
 * door to the other side and the one a reader walked through without meaning
 * to: one press from `chr:10,001-30,000` and the picture was split down the
 * middle at the junction. `circular` now says only that a window **already**
 * across the origin — the one window whose end is below its start — is a
 * window, measured the long way round the outside: it widens and narrows about
 * its own middle as any window does, a widening keeping the origin inside it,
 * and past one lap it is the whole sequence, because a window wider than the
 * circle would draw the same bins twice.
 */
export function zoomedRegion(
  window: FramedRegion,
  factor: number,
  options: { circular?: boolean; floor?: number } = {},
): string | null {
  const { contig, length } = window
  // **A window across the origin is measured the long way round the outside.**
  // It is the one window whose end is below its start, and subtracting them
  // gives a negative span — which would refuse to widen or narrow a frame the
  // reader typed or reached with `ori` (§8.15). Only that window: one that does
  // not cross the origin is zoomed as on a line, circle or not.
  const round = options.circular === true && !(window.end > window.start)
  const span =
    window.end > window.start
      ? window.end - window.start
      : round
        ? length - window.start + window.end
        : Number.NaN
  if (!(span > 0) || !(length > 0) || !(factor > 0)) return null
  // Already the whole of it. Only in the widening direction: a whole chromosome
  // is a perfectly ordinary thing to zoom *into*.
  if (factor > 1 && span >= length) return null
  const floor = Math.max(1, Math.round(options.floor ?? 1))
  const wanted = Math.round(span * factor)
  if (wanted < floor || wanted === span) return null
  // A press that would reach past the sequence lands *on* it, and the bare name
  // is how this application spells the whole of something everywhere else.
  if (factor > 1 && wanted >= length) return contig
  // From the window's own start, so a wrapped one is centred on the middle of
  // what is drawn rather than on the midpoint of two coordinates that run
  // backwards past each other.
  const centre = window.start + span / 2
  let start = Math.round(centre - wanted / 2)
  let end = start + wanted

  if (round) {
    const wrap = (at: number): number => ((at % length) + length) % length
    const from = wrap(start)
    const to = wrap(end)
    // The two ends landing on the same base is a lap exactly, which is the whole
    // sequence and is named as one.
    return from === to ? contig : `${contig}:${from}-${to}`
  }

  if (start < 0) {
    start = 0
    end = wanted
  } else if (end > length) {
    end = length
    start = length - wanted
  }
  return `${contig}:${start}-${end}`
}

/**
 * The window on screen, moved along its sequence by `fraction` of its own width —
 * as a region string.
 *
 * Negative is upstream, toward base 1; the buttons beside `go` move half a
 * window each way (§5.4), so what was at one edge is in the middle after a press.
 * Against an end of the sequence the window slides in to stop *at* the end
 * rather than overhanging it, and `null` — which greys the button — when it is
 * already there, or already the whole sequence.
 *
 * **On a circle a press stops at the ends, as on a line**, for the reason the
 * zoom steps do (§8.15): `ori` and a window typed across the origin are the ways
 * to the other side of it. A window *already* across the origin moves round the
 * circle, since it has no end to stop against.
 */
export function shiftedRegion(
  window: FramedRegion,
  fraction: number,
  options: { circular?: boolean } = {},
): string | null {
  const { contig, length } = window
  const round = options.circular === true && !(window.end > window.start)
  const span =
    window.end > window.start
      ? window.end - window.start
      : round
        ? length - window.start + window.end
        : Number.NaN
  if (!(span > 0) || !(length > 0) || span >= length || fraction === 0) return null
  const by = Math.round(span * fraction)
  if (by === 0) return null

  if (round) {
    const wrap = (at: number): number => ((at % length) + length) % length
    return `${contig}:${wrap(window.start + by)}-${wrap(window.start + by + span)}`
  }

  const start = Math.min(Math.max(0, window.start + by), length - span)
  if (start === window.start) return null
  return `${contig}:${start}-${start + span}`
}

/** The two half-window moves beside `go`, upstream first. */
export const PAN_STEPS: ReadonlyArray<{ fraction: number; upstream: boolean }> = [
  { fraction: -0.5, upstream: true },
  { fraction: 0.5, upstream: false },
]

/**
 * One zoom step, as a button: the mark for the direction and the factor beside it.
 *
 * Exported with {@link ZOOM_STEPS} so the 1D browser's bar draws the same four
 * buttons from the same pair: the two bars are the same control over two
 * pictures of one genome, and two sets of zoom buttons that did not match was
 * the app telling a reader that zooming means something different on each.
 *
 * `btn-keyed`'s shape without its key badge — a mark, a word, one baseline —
 * because four bare magnifiers in a row cannot be told apart and four words
 * without marks cannot be told from the controls either side of them. Bordered
 * like `go` next to it: these move the view.
 */
export function zoomButton(
  step: { factor: number; label: string; out: boolean },
  onClick: () => void,
): HTMLButtonElement {
  const node = el('button', { class: 'btn btn-keyed btn-zoom', type: 'button' })
  node.append(
    icon(step.out ? 'zoom-out' : 'zoom-in', { size: 14 }),
    el('span', { text: step.label }),
  )
  node.addEventListener('click', onClick)
  return node
}

/** The whole sequence each axis is a window on, in bins. */
interface Ceiling {
  rows: [number, number]
  cols: [number, number]
}

/**
 * Whether a window runs off either end of its sequence — a window across a
 * circle's origin, in the unwrapped bins it is read in (§8.15).
 */
function runsOff(window: [number, number], sequence: [number, number]): boolean {
  return window[0] < sequence[0] || window[1] > sequence[1]
}

export class RegionView {
  readonly el: HTMLElement
  /**
   * The view's own controls, mounted by the shell in the right-hand column
   * rather than inside this element — see `App.showContent`.
   */
  readonly sideEl: HTMLElement
  /**
   * The heatmap panel, exposed so the shell can reach it.
   *
   * The manual-annotation card lives in the sidebar and the plot lives in
   * whichever view is mounted, so "click the map to place a mark" has to cross
   * that gap. The shell forwards to this; the view itself stays unaware.
   */
  readonly panel: MatrixPanel
  private readonly search: SearchBox
  /**
   * The four zoom steps, in {@link ZOOM_STEPS} order.
   *
   * Built in the constructor rather than in the header, because their state is
   * written from the draw loop: {@link MatrixPanelOptions.onViewMoved} fires
   * whenever the window changes and {@link syncZoom} greys whichever of the four
   * has nowhere to go.
   */
  private readonly zooms: HTMLButtonElement[]
  /** The two half-window moves, in {@link PAN_STEPS} order, greyed by {@link syncZoom}. */
  private readonly pans: HTMLButtonElement[]
  private readonly matched: HTMLElement
  private readonly title: HTMLElement
  private readonly problem: HTMLElement
  private disposed = false
  /**
   * The zoom's own reader, once a block is on screen.
   *
   * Built after the first read rather than in the constructor, because it
   * needs the ceiling — and the ceiling is the *whole sequence* this region
   * is a window into, which is the one thing a region view knows and the
   * other views do not. A genome view already reads its whole genome, so
   * there is nowhere further out for it to go; a region is a window, and
   * zooming out of a window should reach the rest of what it is a window on.
   */
  private ladder: BlockLadder | null = null
  /**
   * What the ladder was last armed with, so it can be armed again.
   *
   * Held for one caller — {@link setCircular} — and it is the difference
   * between a declaration that costs the reader their zoom and one that does
   * not. Arming needs the parsed range and the block that was installed, and
   * both are settled inside {@link load}; keeping them is what lets the ladder
   * be rebuilt against the picture on screen rather than by reloading the view
   * from its named region.
   */
  private armed: { rows: ParsedRange; result: MatrixResult; cols?: ParsedRange } | null = null

  constructor(private readonly props: RegionViewProps) {
    const store = props.annotations?.store
    this.search = new SearchBox({
      inputClass: 'input-region',
      // **The form a reader reads** (§26.1), not the one the state carries: the
      // box shows `IV:1,000,001-1,400,000` where the hash and the worker say
      // `IV:1000000-1400000`, and what is typed is read back the same way. The
      // heading over this box and the summary under it each wrote one of the two
      // grammars, so one screen named one window at two starts a base apart and
      // a coordinate copied out of the summary and into the box moved the
      // picture by a base — which is the failure a genomics reader is quickest
      // to see and slowest to forgive.
      // A block of two windows shows both, as its title does, so Enter on it
      // opens the block it is showing rather than the rows alone (§5.4).
      value: props.region2 === undefined ? regionLabel(props.region) : pairLabel(props.region, props.region2),
      // **The sequence this view is of, where that is what it is of.** A
      // coordinate suffix on a *genome* name is an error here (§5.4) and the
      // name this view is handed may be a genome's — so the example is taken
      // from a region that already *has* coordinates, and only where there are
      // none does it fall back to the noun. It used to be the noun always, which
      // offered `chromosome:1,000-20,000`: a category where every other box in
      // the app names a sequence.
      placeholder: locusPlaceholder({
        first: props.region.includes(':') ? props.region.split(':')[0] : props.noun,
        // A genome name is something only a multi-genome file answers — a dev
        // feature (§29) — so a page with it off does not offer one.
        accepts: { sequence: true, genome: devFeature('metacool'), gene: store !== undefined },
      }),
      title:
        store === undefined
          ? 'What this view is of. Type a name or a locus — the first base is 1, as the ' +
            'summary reads — or two loci with × between them for the block where they meet, and ' +
            'press Enter.'
          : 'What this view is of. Type a name, a locus (the first base is 1, as the summary ' +
            'reads), two loci with × between them for the block where they meet, or a gene from ' +
            'the starred model, and press Enter.',
      // The box draws its own `go`, as the browser's does: one shape for one
      // job (§26.6), and Enter and the button are one road through `submit`
      // rather than two that can come to disagree about what the box holds.
      go: true,
      // One window, or two — rows, then columns — for a block between them.
      // A gene picked from the list is read with context round it (§5.4): the
      // block is the gene and a hundred bins either side, framed on the gene,
      // so a wheel back out finds the neighbourhood rather than the paper past
      // a block cut to the gene. Coordinates typed are a block asked for, and
      // are cut as asked.
      onSubmit: (text, hit) => {
        const typed = typedLociToRegions(text)
        if (hit !== undefined && typed.region2 === undefined) {
          void this.openWithContext(typed.region)
          return
        }
        props.onChangeRegion(typed.region, typed.region2)
      },
      // Only where there is something to search. A map with no gene model
      // loaded would grow a list that never has anything in it.
      //
      // A hit carries the feature's own bounds in the *state's* grammar
      // (`featureSuggestions`, whose base is pinned by a test), and the box
      // shows what the box accepts — so a hit is put in it as the locus a
      // reader reads, and picking a gene lands on the gene rather than a base
      // before it.
      ...(store === undefined
        ? {}
        : {
            suggest: (text: string) =>
              featureSuggestions(store, text).map((hit) => ({
                ...hit,
                value: regionLabel(hit.value),
              })),
          }),
    })
    // Ordinary bordered buttons, like `go` beside them: these move the view, and
    // a control that moves the view reading as quietly as a label is a control
    // nobody finds. The mark says which way and the number says how far.
    this.zooms = ZOOM_STEPS.map((step) => zoomButton(step, () => this.stepZoom(step.factor)))
    // Bare marks, bordered like `go` beside them: an arrow along the sequence
    // says which way, and half a window is the one distance there is.
    this.pans = PAN_STEPS.map((step) =>
      iconButton(
        step.upstream ? 'move-left' : 'move-right',
        step.upstream ? 'Move half a window upstream' : 'Move half a window downstream',
        () => this.stepPan(step.fraction),
        { class: 'btn btn-icon btn-pan', size: 14 },
      ),
    )
    this.matched = el('span', { class: 'match-kind' })
    // One line under the title, with the whole of it in a tooltip where it is cut.
    titleWhenCut(this.matched)
    this.problem = el('p', { class: 'inline-error hidden' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      ...(props.caption === undefined ? {} : { caption: props.caption }),
      ...(props.annotations === undefined ? {} : { annotations: props.annotations }),
      ...(presentationOf(props.compare) === undefined
        ? {}
        : { compare: presentationOf(props.compare) }),
      ...(props.lower === undefined ? {} : { lower: props.lower }),
      initial: props.scale,
      // Same shape as the genome view: heading names the selection, controls
      // live in the sidebar. Only the Contigs card is missing, because inside a
      // single contig there is no list to offer.
      detachedControls: true,
      hideTitle: true,
      balance: props.balance,
      ...(props.derive === undefined ? {} : { derive: props.derive }),
      ...(props.turn === undefined ? {} : { turn: props.turn }),
      scores: {
        choices: scoreChoices(props),
        current: scoreFor(scoreChoices(props), props).id,
        onChange: (choice) => props.onScoreChange(choice),
      },
      onScaleChange: (scale) => props.onScaleChange(scale),
      onViewMoved: () => this.syncZoom(),
      // This bar has an `h2` naming the window, and the summary line sits
      // directly under it — so the summary prints the span alone where the two
      // would say the same thing. See `MatrixPanel.setWindowNamedAbove`.
      headingLocus: () => this.title.textContent,
      // A click on a cell opens the sequence the window is on (below), and
      // nothing on the picture says so.
      clickHint: () => {
        if (props.region2 !== undefined) return null
        const window = parseRegion(props.region)
        return window === null ? null : `click to see the whole of ${regionLabel(window.contig)}`
      },
      onCellClick: (_cell, groups) => {
        if (groups.row !== undefined && groups.row.label !== props.region) {
          props.onChangeRegion(groups.row.label)
        }
      },
      // On a contig × contig block the two axes are different contigs, and the
      // label is how you drop the other one: click the row name to open that
      // contig by itself.
      onLabelClick: (_axis, name) => {
        if (name !== props.region) props.onChangeRegion(name)
      },
      // Narrowing by drawing: the same view over a smaller range on the
      // diagonal, and the rectangle between the two windows anywhere else —
      // including above the diagonal of a single contig, which is where the
      // long-range structure of that contig lives.
      onSelectRegion: (selection) =>
        selection.diagonal
          ? props.onChangeRegion(axisRegion(selection.rows))
          : props.onChangeRegion(axisRegion(selection.rows), axisRegion(selection.cols)),
    })

    // The heading *is* the region, as the genome view's heading is the genome;
    // a literal "Region" above a box that already says which one was a line
    // spent on the obvious.
    this.title = el('h2', { class: 'region-title', text: regionLabel(props.region) })
    // Ellipsised on the one-line heading rather than allowed to push the
    // toolbar down (`ui/styles.css`), so the locus it cut is in its tooltip.
    titleWhenCut(this.title)
    this.panel.setWindowNamedAbove(true)

    this.el = el(
      'section',
      { class: 'view view-region' },
      el(
        'header',
        { class: 'view-head' },
        // `.title-bar`, the same wrapper every other view heading uses — the
        // region box rides on the title line rather than in a row of its own,
        // because it *is* the title: typing in it is how you change what this
        // view is of.
        el(
          'div',
          { class: 'title-bar region-bar' },
          this.title,
          ...(props.neighbours === undefined || props.onStep === undefined
            ? []
            : [stepper({ neighbours: props.neighbours, onStep: props.onStep, noun: props.noun })]),
          // **The toolbar is one group, so it moves as one line.** The bar
          // wraps, and only the box was pushed right, so the four zoom steps
          // and the bookmark broke away onto a line of their own *under the
          // title* — beside nothing, two rows above the subtitle, and in a
          // different arrangement at every width: three shapes of one bar at
          // three window sizes. §5.4 says zoom is four buttons beside the box
          // "because what they change is the coordinate the box holds", and
          // that is only true while they are beside it.
          el(
            'div',
            { class: 'title-tools' },
            // `go` rides inside the box (`SearchBox`'s own option), because
            // Enter and the button mean the same thing and a hit list the
            // button could not see would make them disagree about what "go" is.
            this.search.el,
            // **Half a window upstream and downstream**, straight after `go`
            // because they are the same act — a different range, through the
            // ordinary navigation — with the box saying where it lands. The
            // drag on the map moves the *picture* and stops at the edge of what
            // was read; these re-read, so a reader at a locus can walk along
            // the sequence without retyping it.
            el('div', { class: 'pan-steps' }, ...this.pans),
            // **The zoom steps, beside the box, because they write into the box.**
            // The scroll wheel on the map is a zoom of the *picture* — the same
            // block, drawn larger or smaller — and past the edge of what was read
            // it stops. These are the other thing "zoom" means on a genome
            // browser: a different *range*, re-read, with the region string
            // updated to say so. They sit here rather than on the map because this
            // is where the coordinate they change is written.
            //
            // **No back button.** It was `window.history.back()` under an arrow,
            // which is the browser's own back with a second face — the key, the
            // trackpad gesture and the chrome all already reach it, and a fourth
            // way to press it cost a slot on the one line every other control here
            // is about *this* view.
            //
            // **One group, so the four wrap together or not at all.** They are a
            // scale — widest out to widest in, with the window you are on in the
            // middle — and a bar narrow enough to break the row was breaking it
            // *between* them, leaving `10×` alone at the end of one line and the
            // other three on the next. That reads as two controls rather than one
            // axis, and which three happened to fit said nothing about anything.
            el('div', { class: 'zoom-steps' }, ...this.zooms),
            // Beside `go`, because it is about the same thing `go` is: the box
            // says where to be and this says *remember this*. A bookmark button
            // in the sidebar would have been a card control, and the hand that
            // has just arrived somewhere worth keeping is up here.
            ...(props.boxControl === undefined ? [] : [props.boxControl]),
          ),
        ),
        this.matched,
        this.problem,
      ),
      this.panel.el,
    )

    this.sideEl = el('aside', { class: 'side' }, ...this.panel.cards)

    // Greyed until there is a picture to scale. The draw loop takes them from
    // here — {@link MatrixPanelOptions.onViewMoved} fires on the first frame of
    // the first block, and on every pan and zoom after it.
    this.syncZoom()
    void this.load()
  }

  /**
   * Adopt a colour scale the URL moved to (a shared link, the back button).
   *
   * Delegated to the panel, which repaints without echoing the change back out.
   * Its existence is what lets `App.render` treat a colour-only state change as
   * a repaint rather than as a reason to rebuild this view and re-read its
   * matrix.
   */
  applyScale(scale: ScaleState): void {
    this.panel.applyScale(scale)
  }

  /** The `/` key: this view's box is the region box, which is also its title. */
  focusSearch(): void {
    this.search.focus()
  }

  /**
   * One press of a zoom step: a different range, through the ordinary navigation.
   *
   * `onChangeRegion` rather than a read of its own, so the new window is a
   * history entry and a shareable link like every other place this view goes
   * (§5.5) — pressing it three times and going back three times is the same
   * journey in reverse.
   */
  private stepZoom(factor: number): void {
    const target = this.zoomTarget(factor)
    if (target !== null) this.props.onChangeRegion(target)
  }

  /** One press of a pan step: half a window along the sequence, as a navigation. */
  private stepPan(fraction: number): void {
    const target = this.panTarget(fraction)
    if (target !== null) this.props.onChangeRegion(target)
  }

  /** Where a pan would take the view, refused off the diagonal as a zoom is. */
  private panTarget(fraction: number): string | null {
    if (this.props.region2 !== undefined) return null
    const framed = this.panel.framedRegion()
    if (framed === null) return null
    return shiftedRegion(framed, fraction, { circular: this.props.circular?.on === true })
  }

  /**
   * Where a press would take the view, or `null` when it would take it nowhere.
   *
   * Refused off the diagonal for the reason the panel refuses to name one window
   * there: a `contig × contig` block is a picture of two places, and scaling
   * "the" range would have to pick one of them.
   */
  private zoomTarget(factor: number): string | null {
    if (this.props.region2 !== undefined) return null
    const framed = this.panel.framedRegion()
    if (framed === null) return null
    return zoomedRegion(framed, factor, {
      circular: this.props.circular?.on === true,
      // A window narrower than a bin is a window of one bin under a coordinate
      // nobody can act on, so the file's own grain is where zooming in stops.
      floor: this.props.binsize,
    })
  }

  /** Grey whichever steps have nowhere to go, and say where the others lead. */
  private syncZoom(): void {
    ZOOM_STEPS.forEach((step, at) => {
      const node = this.zooms[at]
      if (node === undefined) return
      const target = this.zoomTarget(step.factor)
      node.disabled = target === null
      node.title =
        target === null
          ? step.out
            ? 'The whole sequence is on screen — there is nothing further out to go to'
            : 'This window is already at the file’s own bin size'
          : `${step.out ? 'Widen' : 'Narrow'} the range ${step.label} about what is on screen: ` +
            regionLabel(target)
    })
    PAN_STEPS.forEach((step, at) => {
      const node = this.pans[at]
      if (node === undefined) return
      const target = this.panTarget(step.fraction)
      const way = step.upstream ? 'upstream' : 'downstream'
      const title =
        target === null
          ? this.props.region2 !== undefined
            ? 'A block of two sequences has no one range to move along'
            : `There is nothing further ${way} on this sequence`
          : `Move half a window ${way}: ${regionLabel(target)}`
      node.disabled = target === null
      node.title = title
      node.setAttribute('aria-label', title)
    })
  }

  destroy(): void {
    this.disposed = true
    this.ladder?.destroy()
    this.ladder = null
    this.panel.destroy()
  }

  /**
   * Let the zoom read, now that there is a picture to zoom into.
   *
   * The ceiling is the **whole sequence** each axis is a window on, not the
   * window itself: a region is the one view that is a viewport onto something
   * bigger, so zooming out of it should reach the rest of the chromosome rather
   * than stop at the edge of whatever was typed in the box. It costs one `range`
   * request per axis, which reads no pixels — `parsed.contig` names the sequence
   * and the reader answers with its bin extent from `chrom_offset` arithmetic
   * (§4).
   *
   * Rebuilt per load, because a navigation is a different window on a possibly
   * different sequence, and a ladder holding the last one would hand back blocks
   * of somewhere else.
   */
  /**
   * Stand the picture on {@link RegionViewProps.focus}, if there is one.
   *
   * Silent when there is no focus and silent when it will not place — a contig
   * this block does not carry, a level with no coordinates in it. The fitted view
   * is a good answer to a window that could not be found, and an error line about
   * one would be reporting a failure the reader can already see the absence of.
   *
   * Also the second entry point, {@link showFocus}: going to another saved place
   * on the same chromosome is a zoom rather than a navigation, and the shell takes
   * that road (`ViewState.differsOnlyInFocus`).
   */
  private applyFocus(): void {
    const region = this.props.focus
    // A two-contig block has no diagonal to stand a locus on: its axes are two
    // different sequences, so one window cannot name a place on both of them.
    // Refused here rather than in the panel, which would refuse it by finding no
    // row for the contig — the same outcome by accident instead of on purpose.
    if (region === undefined || this.props.region2 !== undefined) return
    const parsed = parseRegion(region)
    if (parsed !== null) this.panel.showLocus(parsed)
  }

  /**
   * Move to a saved place without rebuilding — the counterpart of
   * {@link applyScale}.
   *
   * The prop is written too, so a later reload of the block (a refine widening
   * past what is held, a change of level) stands on the place the reader is
   * actually at rather than on the one the view was constructed for.
   */
  showFocus(region: string | undefined): void {
    if (region === undefined) {
      delete this.props.focus
      return
    }
    this.props.focus = region
    this.applyFocus()
  }

  /**
   * Adopt a change of the circular declaration, keeping the picture (§8.15).
   *
   * The declaration changes how the block is **read** — whether the window may
   * run off the end of the sequence, and whether the ceiling is a position or a
   * width — so the ladder has to be built again. Nothing else does: the block on
   * screen is a block of this sequence either way, and rebuilding the view would
   * reload it from its *named region*, throwing away the zoom the reader needed
   * in order to be somewhere the question is worth asking from.
   *
   * The presentation object is written through rather than replaced, because
   * {@link armRefine} reads `circular.on` at arm time and the session hands a
   * fresh object over only on its next render.
   */
  setCircular(on: boolean): void {
    const held = this.armed
    if (this.props.circular === undefined || held === null) return
    if (this.props.circular.on === on) return
    this.props.circular.on = on
    // The block that is *drawn*, not the one the view first loaded: the reader
    // has very likely zoomed since, and a ladder that adopted the original
    // would plan its next read from an extent nobody is looking at.
    const shown = this.panel.block ?? held.result
    void this.armRefine(held.rows, shown, held.cols)
  }

  private async armRefine(
    rows: ParsedRange,
    result: MatrixResult,
    cols: ParsedRange | undefined,
    known?: Ceiling | null,
  ): Promise<void> {
    this.ladder?.destroy()
    this.ladder = null
    this.armed = { rows, result, ...(cols === undefined ? {} : { cols }) }
    // `known` is the ceiling the load has already paid for, which it needs
    // *before* the first read on a circular sequence — a window across the
    // origin cannot be read without knowing what a lap is. Asking again here
    // would be a second `range` request for an answer already in hand.
    const whole = known ?? (await this.wholeOf(rows, cols))
    if (this.disposed || whole === null) return
    // **A window across a circle's origin is a frame** (§8.15): the `ori`
    // framing, or one typed backwards. Its extent runs off the end of the
    // sequence, it is read wrapped — the worker resolves it modulo the
    // sequence — and it is the ceiling: a zoom inside it refines as it does
    // anywhere, and nothing reads past it.
    //
    // It used to be a place to start sliding from. Any window on a declared
    // circle was read with no ends, and a pan past the edge of the block read
    // the next stretch round, block after block, whatever the refine setting
    // said. It was not smooth and it lost readers; `ori` is the way to the
    // other side of the origin, and a window that is not across it pans as a
    // window on a line does, to the sequence's ends.
    //
    // On a two-contig block there is nothing to wrap — the axes are two
    // different sequences — so this is `undefined` there.
    const wrap =
      cols === undefined && this.props.circular?.on === true && runsOff(rows.extent, whole.rows)
        ? whole.rows
        : undefined
    const ceiling: Ceiling = wrap === undefined ? whole : { rows: rows.extent, cols: rows.extent }
    const query = (
      rowExtent: [number, number],
      colExtent: [number, number],
      rung?: string,
      binsPerCell?: number,
    ) => ({
      kind: 'matrix' as const,
      ...(rung === undefined ? {} : { rung }),
      rows: rowExtent,
      ...(cols === undefined ? {} : { cols: colExtent }),
      ...(wrap === undefined ? {} : { wrap }),
      ...(binsPerCell === undefined ? {} : { binsPerCell }),
      balance: this.props.balance,
      ...(this.props.value === undefined ? {} : { value: this.props.value }),
    })
    this.ladder = attachRefine({
      panel: this.panel,
      ceiling,
      binsize: this.props.binsize,
      rungs: rungsOf(this.props.rungs ?? []),
      // The grid the reader declared (§3.4), so a zoom cannot quietly read past
      // the resolution the axis is labelled with.
      floor: () => this.props.binsPerCell ?? 1,
      read: (rowExtent, colExtent, rung, binsPerCell) => {
        const own = this.props.client.cancellable<'matrix'>(
          query(rowExtent, colExtent, rung, binsPerCell),
        )
        return {
          cancel: own.cancel,
          promise: own.promise.then(async (block) => {
            const second = await secondBlock(this.props.compare ?? this.props.lowerRead, (client) =>
              client.request<'matrix'>(query(rowExtent, colExtent, rung, binsPerCell)),
            )
            return second === undefined ? { result: block } : { result: block, second }
          }),
        }
      },
      onInstalled: (block) => {
        if (cols === undefined) this.describeMatch(rows, block)
        else this.describePair(block)
      },
      onError: (err) => {
        // Said once, in the line the region box already reports into, and not
        // per frame: `BlockLadder` remembers a refusal so the same read is not
        // reissued, and this is the sentence that goes with it.
        this.problem.textContent = err instanceof Error ? err.message : String(err)
        this.problem.classList.remove('hidden')
      },
    })
    this.ladder.adopt(result)
  }

  /**
   * `{ binsPerCell }` where the reader declared a resolution, else nothing.
   *
   * Spread into every `matrix` request this view makes, so the first read and
   * every refine after it are on one grid. Absent rather than `1` on the
   * ordinary path, because `1` is a plan and absent is *choose one*: the reader
   * fits the finest grid the window's cell count allows, which is what a view of
   * a whole chromosome has always relied on.
   */
  /**
   * `{ rung }` where a sibling rung draws this window's first picture from
   * fewer pixels with nothing lost ({@link poolingRung}), else nothing.
   *
   * Not with a declared grid, which is a whole number of the *open* map's bins
   * (§3.4), nor beside a second file, whose ladder need not have the rung.
   */
  private firstRung(rows: [number, number], cols: [number, number]): { rung?: string } {
    if ((this.props.binsPerCell ?? 1) > 1 || this.props.compare !== undefined) return {}
    const rung = poolingRung(rungsOf(this.props.rungs ?? []), rows, cols, this.props.binsize)
    return rung === undefined ? {} : { rung }
  }

  private pooled(): { binsPerCell?: number } {
    const k = this.props.binsPerCell ?? 1
    return k > 1 ? { binsPerCell: k } : {}
  }

  /**
   * Open `region` framed, inside a block {@link SEARCH_CONTEXT_BINS} bins wider
   * each side, clipped to its sequence.
   *
   * The sequence's length is asked of the worker, as {@link wholeOf} asks it,
   * and the far end is held a bin short of it: the last bin is partial, and a
   * range past the end is refused rather than clipped (§10). Anything that
   * cannot be read that way — no coordinates, a name the file does not hold —
   * is opened as it was asked.
   */
  private async openWithContext(region: string): Promise<void> {
    const window = parseRegion(region)
    if (window === null) {
      this.props.onChangeRegion(region)
      return
    }
    let bins: number
    try {
      const whole: ParsedRange = await this.props.client.request<'range'>({ kind: 'range', range: window.contig })
      bins = whole.extent[1] - whole.extent[0]
    } catch {
      this.props.onChangeRegion(region)
      return
    }
    const bin = this.props.binsize * (this.props.binsPerCell ?? 1)
    const pad = SEARCH_CONTEXT_BINS * bin
    const last = Math.max(window.end, (bins - 1) * this.props.binsize)
    const start = Math.max(0, window.start - pad)
    const end = Math.min(last, window.end + pad)
    this.props.onChangeRegion(formatRegion({ contig: window.contig, start, end }), undefined, region)
  }

  /**
   * The bin extent of the whole sequence each axis is a window on.
   *
   * `null` where an axis is not a window on a single sequence — a range that
   * names several, or one the reader has since navigated away from — and the
   * zoom then simply does not read, which is today's behaviour and is never
   * wrong, only less.
   */
  private async wholeOf(rows: ParsedRange, cols: ParsedRange | undefined): Promise<Ceiling | null> {
    const whole = async (range: ParsedRange): Promise<[number, number] | null> => {
      // A genome range is already whole — `metacooler` refuses coordinates on
      // one (§10) — so its own extent is the ceiling and there is nothing to ask.
      if (range.kind === 'genome') return range.extent
      try {
        const full: ParsedRange = await this.props.client.request<'range'>({
          kind: 'range',
          range: range.label,
        })
        return full.extent
      } catch {
        return null
      }
    }
    const rowCeiling = await whole(rows)
    if (rowCeiling === null) return null
    if (cols === undefined) return { rows: rowCeiling, cols: rowCeiling }
    const colCeiling = await whole(cols)
    return colCeiling === null ? null : { rows: rowCeiling, cols: colCeiling }
  }

  /**
   * The sequences this view may read as circles, for a `range` request.
   *
   * One name and only where it has been declared, because that is all a region
   * view is about. It is what lets `chr:2,900,000-100,000` mean the window
   * across the origin rather than a typing mistake — the worker cannot know it
   * (§8.15), so it is asked with the question.
   */
  private circularNames(): readonly string[] | undefined {
    const declared = this.props.circular
    return declared?.on === true ? [declared.label] : undefined
  }

  private async load(): Promise<void> {
    if (this.props.region === '') return
    this.panel.setBusy(true)
    this.problem.classList.add('hidden')
    this.panel.noteRendered(null)
    try {
      const declared = this.circularNames()
      const parsed: ParsedRange = await this.props.client.request<'range'>({
        kind: 'range',
        range: this.props.region,
        ...(declared === undefined ? {} : { circular: declared }),
      })
      const [lo, hi] = parsed.extent

      if (this.props.region2 === undefined) {
        // **The ceiling before the first read, on a circle.** A window typed
        // across the origin comes back as an extent that runs off the end of the
        // sequence, and a read of one is only a read at all if it is told what a
        // lap is. On a linear sequence nothing is asked here and the ladder pays
        // for its own ceiling afterwards, as it always did.
        const ceiling = declared === undefined ? null : await this.wholeOf(parsed, undefined)
        if (this.disposed) return
        const wrap = ceiling === null ? undefined : ceiling.rows
        const ask = {
          kind: 'matrix' as const,
          rows: [lo, hi] as [number, number],
          ...this.firstRung([lo, hi], [lo, hi]),
          ...(wrap === undefined ? {} : { wrap }),
          ...this.pooled(),
          balance: this.props.balance,
          ...(this.props.value === undefined ? {} : { value: this.props.value }),
        }
        const result: MatrixResult = await this.props.client.request<'matrix'>(ask)
        const second = await secondBlock(this.props.compare ?? this.props.lowerRead, (client) =>
          client.request<'matrix'>(ask),
        )
        if (this.disposed) return
        this.title.textContent = regionLabel(this.props.region)
        this.describeMatch(parsed, result)
        // The reader may have planned a coarser grid than the file's bins — a
        // whole chromosome at 10 kb is more cells than any picture holds — and
        // every coordinate on screen is the bin size times a cell offset, so the
        // panel is told before it is given the block.
        this.panel.setResolution((result.binsize ?? this.props.binsize) * (result.binsPerCell ?? 1))
        // The panel names its figure after this (`exportBaseName`), so it is
        // given the window as the heading prints it, 1-based, rather than the
        // state's 0-based string — a saved PDF was otherwise named one base off
        // the caption inside it.
        this.panel.setData(result, regionLabel(this.props.region), second)
        // After the block and *before* the ladder is armed, which is the whole
        // reason it is here rather than in the panel's own setup: the refine
        // reads the window that is on screen, so focusing first means the finer
        // block that arrives is a finer block of the bookmark rather than of the
        // fitted chromosome nobody is looking at any more.
        this.applyFocus()
        await this.armRefine(parsed, result, undefined, ceiling)
        return
      }

      const other: ParsedRange = await this.props.client.request<'range'>({
        kind: 'range',
        range: this.props.region2,
      })
      const [lo2, hi2] = other.extent
      const pair = {
        kind: 'matrix' as const,
        rows: [lo, hi] as [number, number],
        cols: [lo2, hi2] as [number, number],
        ...this.firstRung([lo, hi], [lo2, hi2]),
        ...this.pooled(),
        balance: this.props.balance,
        ...(this.props.value === undefined ? {} : { value: this.props.value }),
      }
      const result: MatrixResult = await this.props.client.request<'matrix'>(pair)
      const second = await secondBlock(this.props.compare ?? this.props.lowerRead, (client) =>
        client.request<'matrix'>(pair),
      )
      if (this.disposed) return
      this.title.textContent =
        pairLabel(this.props.region, this.props.region2)
      this.describePair(result)
      // The reader may have planned a coarser grid than the file's bins — a
      // whole chromosome at 10 kb is more cells than any picture holds — and
      // every coordinate on screen is the bin size times a cell offset, so the
      // panel is told before it is given the block.
      this.panel.setResolution((result.binsize ?? this.props.binsize) * (result.binsPerCell ?? 1))
      this.panel.setData(result, pairLabel(this.props.region, this.props.region2), second)
      await this.armRefine(parsed, result, other)
    } catch (err) {
      // A view that has been torn down must not navigate the shell. Closing the
      // map puts the reader down, which rejects every read still in flight —
      // and a rejection arriving after the browser has been mounted in this
      // view's place would replace it with an error screen about a worker
      // nobody is waiting for.
      if (this.disposed) return
      // A bad range is a normal, recoverable typing mistake: keep the view and
      // its input, and report the reader's own wording inline. Anything else is
      // a real failure and belongs on the error screen.
      // `dense-too-large` belongs here too: on a cooler, clicking a chromosome
      // in the table is a one-click way to ask for a block no tab can draw, and
      // the answer is a sentence above an intact region box — type a window and
      // carry on — not a full-screen error with a "go back" button.
      if (
        err instanceof ViewerError &&
        (err.code === 'unknown-label' ||
          err.code === 'genome-coordinate-suffix' ||
          err.code === 'unbinned-not-displayable' ||
          // A range that will not parse is the same kind of thing as a name
          // this file has not got: a typing mistake, over an intact box, with
          // the picture the reader was looking at still on screen. It reached
          // the full-screen error page instead — which is a long way back from
          // a missing comma, and further still from `chr:2.9M-100k` on a
          // sequence nobody has declared circular yet (§8.15).
          err.code === 'bad-range' ||
          err.code === 'dense-too-large')
      ) {
        this.problem.textContent = err.message
        this.problem.classList.remove('hidden')
        this.matched.textContent = ''
        // Before the veil comes down, so the report the page makes once it has
        // says what is on screen: the sentence, over the picture that was there.
        this.panel.noteRendered('error', err.message)
        this.panel.setBusy(false)
        return
      }
      this.props.onError(err)
    }
  }

  /** The readout for a rectangular block between two ranges. */
  private describePair(result: MatrixResult): void {
    this.matched.classList.remove('is-genome')
    this.matched.replaceChildren(...blockSummary(this.props.binsize, result), ' · ', this.panel.viewNote)
  }

  private describeMatch(parsed: ParsedRange, result: MatrixResult): void {
    this.matched.classList.toggle('is-genome', parsed.kind === 'genome')
    const parts = blockSummary(this.props.binsize, result)
    // The one part of the line that moves, and last, so a pan changes only the
    // tail of it — see `MatrixPanel.viewNote`.
    parts.push(' · ', this.panel.viewNote)
    if (parsed.kind === 'genome') {
      parts.push(
        button('open genome view →', () => this.props.onOpenGenome(parsed.label), {
          class: 'btn btn-quiet',
        }),
      )
    }
    this.matched.replaceChildren(...parts)
  }

}
