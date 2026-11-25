/**
 * What every part of the curation stage shares (SPECS §33.3): the controller,
 * the file's data, the colours, the ink, the worker's close-up, the readout,
 * framing, and the one drag in flight. The stage (`CurateStage.ts`) makes one
 * and hands it to each pane and card; a pane never reaches past it.
 */

import type { BaseBinning } from '../../genome/curation'
import type { StageInk } from '../../edit/draw'
import type { CurationFocusResult } from '../../worker/curateProtocol'
import type { GenomeColour } from '../colours'
import type { Cancellable, CurateChange, CurateModel } from '../model'
import type { Suggestion } from '../suggest'

/** The file's facts the stage draws from, read once as it opens. */
export interface CurateData {
  /** The map's label, as the session's title gives it. */
  title: string
  /** The file's binning, which every step folds from. */
  file: BaseBinning
  /** Each contig's GC content in percent; `null` where the map stores none. */
  gc: Float64Array | null
  /**
   * Each contig's coverage, for the scatter's height: Hi-C contacts per kb,
   * counted from the network once it is read; `null` until then.
   */
  coverage: Float64Array | null
  /** What {@link coverage} is, as the axis says it. */
  coverageLabel: string
  /** The marker sets the map holds, by name; `[]` without `metator markers`. */
  markerSets: readonly string[]
  /** The network's background ratio, once the network is read. */
  background: number | null
}

/** What is dragged between the panes: contigs, genomes, or an element to link. */
export type CurateDragged =
  | { kind: 'contigs'; contigs: readonly number[] }
  | { kind: 'genomes'; ids: readonly string[] }

/** Where something can be dropped. */
export type CurateDropTarget =
  | { kind: 'genome'; id: string }
  | { kind: 'section'; section: 'mags' | 'elements' }
  | { kind: 'pool' }

/** What a pane asks the stage to show everywhere. */
export interface CurateFrame {
  genomes?: readonly string[]
  contigs?: readonly number[]
}

/** The context every pane and card is built with. */
export interface CurateContext {
  readonly model: CurateModel
  readonly data: CurateData
  /** Whether a genome is laid out by its edit of the reference (§27.10): the list marks it. */
  laidOut(id: string): boolean
  /** A genome's colour, by id: kept by its slot, so a merge or a sort changes none. */
  colourOf(id: string): GenomeColour
  /**
   * A genome's name as the stage prints it: without the prefix its section
   * shares (`00700_00001` for `MM133_metator_00700_00001`), whole where it
   * shares none. Titles, exports and the history keep the full name.
   */
  shortName(id: string): string
  /** The prefix a section's names share, printed once in its head; `''` for none. */
  prefixOf(kind: 'mag' | 'element'): string
  /** The pool's colour. */
  readonly poolColour: GenomeColour
  /** The stage's ink for canvases, read again when the theme changes. */
  ink(): StageInk
  /** Ask the worker for the contacts among some contigs, and their picture. */
  focus(contigs: Int32Array): Cancellable<CurationFocusResult>
  /** One line on the stage's readout, or `null` for its summary. */
  say(text: string | null): void
  /** Show these genomes or contigs in every pane: scroll to them, centre them. */
  frame(target: CurateFrame): void
  /** Hear frame requests. */
  onFrame(listener: (target: CurateFrame) => void): () => void
  /** Start dragging something; the stage draws the ghost and the targets light. */
  startDrag(dragged: CurateDragged, event: PointerEvent): void
  /** The drag in flight, if any. */
  readonly dragging: CurateDragged | null
  /**
   * What dropping the drag in flight on a target would make, in words, or why
   * it would make nothing (`refused`); `null` when nothing is dragged.
   */
  dropWords(target: CurateDropTarget): { words: string; refused: boolean } | null
  /** Drop the drag in flight on a target: the step, made. */
  drop(target: CurateDropTarget): boolean
}

/**
 * One of the stage's pictures: the contact map, the host map, the GC ×
 * coverage scatter. The stage places it — large, or small beside the large
 * one — and tells it what changed; it draws, and answers the hand.
 */
export interface CuratePane {
  readonly element: HTMLElement
  /** Its name, as its tab and key say it. */
  readonly title: string
  /** Repaint for what changed (`model.shown` is what to draw). */
  update(change: CurateChange): void
  /** Its box changed: a resize, or a move between the large place and a small one. */
  resize(): void
  /** Shown large, with all its furniture, or small, as a live thumbnail. */
  setLarge(large: boolean): void
  /** Frame a suggestion's evidence (the review's current one), or nothing. */
  showSuggestion(suggestion: Suggestion | null): void
  /** A key while the pointer or the focus is on it: zoom, fit, a level; `true` when taken. */
  key(event: KeyboardEvent): boolean
  /** Where something held at a viewport point would drop on it, or `null`. */
  dropTargetAt(x: number, y: number): CurateDropTarget | null
  dispose(): void
}
