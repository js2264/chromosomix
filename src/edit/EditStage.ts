/**
 * The stage where the reader edits the reference (SPECS §27.3, §27.4).
 *
 * The third caller of the stage dialog, after the enlarged model and a
 * figure's *customise*: the picture, a sidebar of what is done to it, the grip
 * between them. **One map and its tracks** — the file's whole-genome picture
 * (§27.9), drawn through the edit, with a pieces bar along its top and its left
 * and the lanes placed on the map under it, drawn through the same lens — and
 * never a deck.
 *
 * Every act is a step on the file's {@link EditStore}, so the stage holds no
 * edit of its own: it draws what the store folds into, and a step made here is
 * a step the heading's chip counts and a workspace carries. What the stage does
 * hold is the hand: the view, the selection, the drag, and the preview a drag
 * draws — the map rearranged under the pointer through the edit it would make,
 * with nothing kept until the drop.
 *
 * **Escape never closes it.** It cancels, innermost first — a drag, then the
 * selection — and the stage is closed by its ✕. Its keys are live only while it
 * is open, and printed on the controls that perform them (§26.4).
 */

import type { GroupSettings } from '../annotations/groups'
import type { ManualStore } from '../annotations/manual'
import type { MapId } from '../annotations/placement'
import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import { EditedAssembly, isGap, type AsideReason, type EditStep, type ReferenceEdit } from '../genome/edit'
import { formatLocus, formatPosition } from '../genome/assembly'
import { bpAt } from '../render/locus'
import { Scale } from '../render/scale'
import type { EditStore } from '../state/referenceEdit'
import { AnnotationLanes, type LaneGeometry } from '../ui/AnnotationLanes'
import { el } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { closeMenu, openMenu, type MenuItem } from '../ui/Menu'
import type { Modal } from '../ui/Modal'
import { stageDialog } from '../ui/StageDialog'
import { fmt } from '../units'
import type { GenomeLinksResult, PictureResult, StageWindowSide } from '../worker/protocol'
import { BAR_THICKNESS, drawBar, drawOverlay, readInk, type StageInk } from './draw'
import {
  dropPlace,
  dropStep,
  endTargets,
  landed,
  partStretch,
  snapUnit,
  stretchBetween,
  stretchUnits,
  type Snapped,
  type SnapTarget,
  type Stretch,
} from './gestures'
import { LensGrid, type GridLayout } from './grid'
import { adjustableEnds, adjustSuggestion } from './adjust'
import { ExportCard, type ExportCardProps } from './ExportCard'
import { readSequenceEvidence, type SequenceEvidence } from './sequenceEvidence'
import { drawSuggestions, markSpots, type MarkedSuggestion } from './marks'
import { paintPicture, paintWindow, pictureColours, windowSide, type WindowRead } from './paint'
import { Rail, type RailItem } from './rail'
import { INITIAL_WEIGHTS, learn, suggest, type Suggested, type Suggestion } from './suggest'
import { stepText } from './words'
import type { Learned } from '../state/referenceEdit'
import { recall, remember } from '../state/UiMemory'

/** The lanes the stage draws, as the map they were placed on has them. */
export interface StageLanes {
  store: AnnotationStore
  map?: MapId
  manual?: ManualStore
  client?: AnnotationClient
  groups?: GroupSettings
}

/** A read of the picture in flight, and the way to stop it. */
export interface PictureRequest {
  promise: Promise<PictureResult>
  cancel(): void
}

export interface EditStageProps {
  /** The file's own name, for the heading. */
  title: string
  memoryKey: () => string
  store: EditStore
  /**
   * Start reading the whole-genome picture, reporting progress as it goes —
   * of these sequences of the map alone, where they are given: one genome of a
   * metagenome and the contigs it may bring in (§27.10).
   */
  readPicture(onProgress: (done: number, total: number, note?: string) => void, contigs?: string[], cells?: number): PictureRequest
  /**
   * On one genome of a metagenome (§27.10): read every contact of the file for
   * where the genome's contigs, and the others, belong — without being asked
   * where `auto`, as on a file small enough to read in a moment.
   */
  genomeLinks?: {
    read(contigs: string[], onProgress: (done: number, total: number) => void): { promise: Promise<GenomeLinksResult>; cancel(): void }
    auto: boolean
  }
  /**
   * Count the suggestions for an edit off the stage's thread (§27.12), against
   * what the method weighs of the picture — kept where it was read, under the
   * picture's id (`PictureResult.methodKept`). Absent, a picture that carries
   * the method's data is weighed here.
   */
  suggest?(input: SuggestRequest): { promise: Promise<Suggested>; cancel(): void }
  /**
   * Read the window on screen finer than the picture (§27.9): a rung whose
   * bins are about a pixel, through the stage's edit. Absent, a zoom past the
   * picture's cell shows the cell enlarged.
   */
  readWindow?(request: WindowRequest): { promise: Promise<WindowRead | null>; cancel(): void }
  /** The map lifted through an edit, every rung, as an `.mcool` (§27.8). */
  liftContacts?: ExportCardProps['liftContacts']
  /** On a metagenome: the contig → MAG table every genome's edit makes (§27.10). */
  binning?: ExportCardProps['binning']
  /** The file's sequences the reader declared circular (§8.15), whose origin the stage may set (§27.4). */
  circular?: () => readonly string[]
  /** The map's colours, as its Map card has them. */
  colormap: string
  lanes?: StageLanes
  onClose(): void
}

/** What a finer read of the window on screen is asked for (§27.9). */
export interface WindowRequest {
  edit: ReferenceEdit
  /** Names the edit, so the map drawn through it is kept while it stands. */
  key: string
  /** Base pairs a pixel: the rung wanted is the coarsest no coarser. */
  binsize: number
  /** The picture's cell, which a rung must be finer than to be worth reading. */
  coarser: number
  rows: StageWindowSide
  cols: StageWindowSide
  balance: boolean
}

/** What a count of the suggestions off the stage's thread is asked for. */
export interface SuggestRequest {
  picture: number
  edit: ReferenceEdit
  layout: GridLayout
  weights?: number[]
  evidence?: SequenceEvidence
}

/** What is selected: a stretch on the diagonal, or a box of two off it. */
type Selection = { kind: 'stretch'; stretch: Stretch } | { kind: 'box'; rows: Stretch; cols: Stretch }

/** A drag in progress. */
type Drag =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'along'; anchor: number; x: number; y: number; moved: boolean }
  | { kind: 'box'; ax: number; ay: number; x: number; y: number; moved: boolean }
  /** An end of a suggestion dragged to adjust it (§27.6): which suggestion, which end. */
  | { kind: 'adjust'; key: string; end: 0 | 1; x: number; y: number; moved: boolean }
  | {
      kind: 'move'
      stretch: Stretch
      units: [number, number]
      /** Where along the stretch it was taken hold of, in units. */
      grip: number
      x: number
      y: number
      moved: boolean
      strand: 1 | -1
      copy: boolean
      step: EditStep | null
      /** The unit the stretch would start at, before the step. */
      mark: number | null
    }

/** The fewest contacts a contig's links say anything with, on a genome's card (§27.10). */
const LEAST_LINKS = 5

/** The share of a contig's contacts with a genome from which it is offered to it. */
const BELONGS = 0.4

/** Pixels within which the pointer snaps along an axis (§27.4). */
const SNAP_PX = 8
/** Pixels from the diagonal within which a drag selects along it. */
const DIAGONAL_PX = 12
/** Travel, in pixels, before a press becomes a drag. */
const DRAG_PX = 4

/**
 * How wide a picture cell must be on screen, in pixels, before the window is
 * read again finer than the picture (§27.9): below it the picture shows as
 * much as a pixel can.
 */
const WINDOW_CELL_PX = 2

/**
 * What a value of a window read at `binsize` is multiplied by to be on the
 * picture's scale (§27.9). A picture cell is the sum of `stride²` pixels of
 * its rung; a pixel of a rung `k` times coarser than the window's holds, raw,
 * the sum of `k²` of the window's — and, balanced, about `k` of them, since
 * balancing sets each rung's rows to the same total over `k` times fewer bins.
 */
export function windowScale(picture: Pick<PictureResult, 'binsize' | 'stride' | 'balanced'>, binsize: number): number {
  const k = picture.binsize / picture.stride / binsize
  return picture.stride * picture.stride * (picture.balanced ? k : k * k)
}

/** The picture's sizes a reader may choose, cells a side, the finest first (§27.9). */
const PICTURE_CELL_CHOICES: readonly number[] = [16_384, 8_192, 4_096, 2_048]

/** Where the picture's size is kept for a file. */
const PICTURE_CELLS_SCOPE = 'map:edit-cells'
/** The fewest cells a view may show a side. */
const MIN_SPAN = 12
/** Pixels within which the pointer snaps to a corner, measured in the plane (§27.4). */
const CORNER_PX = 10
/** The rail's width, beside the map. */
const RAIL_WIDTH = 150
/** The confidence auto mode applies at and above (§27.6). */
const AUTO_THRESHOLD = 0.5
/**
 * The least confidence a suggestion is offered at: one a curator would take one
 * time in seven or less is noise on the map, drawn where the reader is judging.
 * Still ranked — an answer about another can raise it — and still listed among
 * those turned down, to be offered again.
 */
const OFFER_FLOOR = 0.15
/** The most steps one run of auto mode makes. */
const AUTO_MOST = 40

/** Who presses accept (§27.6). */
type Mode = 'manual' | 'review' | 'auto'

/** A confidence, as the stage writes it. */
function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`
}

/** A suggestion's kind, in a word. */
const KIND_WORD: Record<Suggestion['kind'], string> = { split: 'split', turn: 'turn', move: 'move', join: 'join' }

const REASONS: Array<{ why: AsideReason; label: string; title: string }> = [
  { why: 'debris', label: 'debris', title: 'Short, unplaceable sequence the assembler left over' },
  { why: 'contaminant', label: 'contaminant', title: 'Not this organism’s: a vector, a bacterium, a sample from next door' },
  { why: 'haplotig', label: 'haplotig', title: 'The other copy of a stretch already in the assembly' },
  { why: 'unplaced', label: 'unplaced', title: 'Belongs to this genome, but the map cannot say where' },
]

export class EditStage {
  private readonly props: EditStageProps
  private readonly modal: Modal
  private readonly root: HTMLElement
  private readonly side: HTMLElement
  private readonly plot: HTMLElement
  private readonly readoutEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly pictureCanvas: HTMLCanvasElement
  private readonly overlayCanvas: HTMLCanvasElement
  private readonly topBar: HTMLCanvasElement
  private readonly leftBar: HTMLCanvasElement
  /** A band per lane stack, lighting the selection on the tracks as on the map. */
  private readonly laneBands: Record<'top' | 'right' | 'bottom' | 'left', HTMLElement>
  private readonly lanes: AnnotationLanes | null
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement
  private readonly selectionCard: HTMLElement
  private readonly historyCard: HTMLElement
  private readonly sequencesCard: HTMLElement
  private readonly pictureCard: HTMLElement
  private readonly suggestionsCard: HTMLElement
  /** On one genome of a metagenome: where its contigs and the others belong (§27.10). */
  private readonly genomeCard: HTMLElement
  private readonly exportCard: ExportCard
  private readonly modes: Record<Mode, HTMLButtonElement>
  private readonly rail: Rail
  private readonly reviewBar: HTMLElement

  private request: PictureRequest | null = null
  private picture: PictureResult | null = null
  private colours: Uint32Array | null = null
  private layout: GridLayout | null = null
  private grid: LensGrid | null = null
  /** The grid a drag is previewing, and where its stretch is in it. */
  private preview: { grid: LensGrid; units: [number, number] | null } | null = null
  private readonly sx = new Scale([0, 1], 1)
  private readonly sy = new Scale([0, 1], 1)
  private size = 0
  private dpr = 1
  private image: ImageData | null = null
  private pictureDirty = true
  private frame = 0
  private selection: Selection | null = null
  private hover: { x: Snapped; y: Snapped; px: number; py: number } | null = null
  private drag: Drag | null = null
  private space = false
  private alt = false
  private ink: StageInk | null = null
  /** Where the map sits in the plot, for the bands over the lanes around it. */
  private mapAt: { x: number; y: number } = { x: 0, y: 0 }
  /** The grid the lanes were last pointed at. */
  private lanesGrid: LensGrid | null = null
  /** What the method weighs, read with the picture (§27.5) — here, or kept where it was read under the picture's id. */
  private method: NonNullable<PictureResult['method']> | null = null
  private methodKept: number | null = null
  /** A count of the suggestions in flight off the stage's thread. */
  private recountRequest: { cancel(): void } | null = null
  /** Auto mode applying, one suggestion and one count at a time. */
  private autoRunning = false
  /** Suggestions whose ends the hand has dragged, by key, until the edit changes (§27.6). */
  private readonly adjustments = new Map<string, Suggestion>()
  /** Names this stage's edits to the reader's worker, a new one each time the edit changes (§27.9). */
  private readonly token = Math.random().toString(36).slice(2)
  private editVersion = 0
  /** The window on screen read finer than the picture, for the edit `key` names; the read in flight; its timer. */
  private windowRead: { key: string; read: WindowRead; view: [number, number, number, number]; asked: number } | null = null
  private windowRequest: { cancel(): void } | null = null
  private windowTimer = 0
  /** The sequence whose name is being typed, on the sequences card; and a line about the last name refused. */
  private renaming: string | null = null
  private sequencesNote = ''
  /** The sequences the picture was read of, where not the whole map. */
  private drawn: Set<string> | null = null
  /** Where a genome's contigs and the others belong, read for the contigs `linksOf` names. */
  private links: GenomeLinksResult | null = null
  private linksOf = ''
  private linksRequest: { cancel(): void } | null = null
  private linksDone: number | null = null
  /** What the session's sequence says about the assembly (§27.5), once read; `null` until then or without one. */
  private evidence: SequenceEvidence | null = null
  /** Whether the sequence is being read for it. */
  private readingEvidence = false
  /** The suggestions for the edit as it stands, and a recount pending. */
  private suggested: Suggested | null = null
  private suggesting = 0
  /** What the reader's answers have taught the stage about this file (§27.6). */
  private learned: Learned
  /** The suggestion lit — hovered on the map, the rail or the list — by key. */
  private lit: string | null = null
  private mode: Mode = 'manual'
  /** The suggestion review mode is on, by key. */
  private current: string | null = null
  /** Space held in review mode: the map as it would be with the current suggestion done. */
  private previewing = false
  /** What the rail was last painted from, so a frame that changes none of it leaves it be. */
  private railSignature = ''
  /** A move begun on a pieces bar: where the press was, on the page, until it travels. */
  private barPress: { x: number; y: number } | null = null
  private closed = false
  private readonly stopStore: () => void
  private readonly observer: ResizeObserver | null
  private readonly onKey: (event: KeyboardEvent) => void
  private readonly onKeyUp: (event: KeyboardEvent) => void
  private readonly onBlur: () => void

  constructor(props: EditStageProps) {
    this.props = props

    this.pictureCanvas = el('canvas', { class: 'edit-picture' })
    this.overlayCanvas = el('canvas', { class: 'edit-overlay', attrs: { tabindex: '0', 'aria-label': 'The edited map' } })
    this.topBar = el('canvas', { class: 'edit-bar edit-bar-top' })
    this.leftBar = el('canvas', { class: 'edit-bar edit-bar-left' })
    this.laneBands = {
      top: el('div', { class: 'edit-lane-band hidden' }),
      right: el('div', { class: 'edit-lane-band hidden' }),
      bottom: el('div', { class: 'edit-lane-band hidden' }),
      left: el('div', { class: 'edit-lane-band hidden' }),
    }
    this.statusEl = el('div', { class: 'edit-status' })
    this.plot = el(
      'div',
      { class: 'edit-plot' },
      this.topBar,
      this.leftBar,
      this.pictureCanvas,
      this.overlayCanvas,
      this.statusEl,
    )

    this.lanes =
      props.lanes === undefined
        ? null
        : new AnnotationLanes({
            store: props.lanes.store,
            ...(props.lanes.map === undefined ? {} : { map: props.lanes.map }),
            ...(props.lanes.manual === undefined ? {} : { manual: props.lanes.manual }),
            ...(props.lanes.client === undefined ? {} : { client: props.lanes.client }),
            ...(props.lanes.groups === undefined ? {} : { groups: props.lanes.groups }),
            onChange: () => this.schedule(),
          })
    if (this.lanes !== null) {
      for (const canvas of Object.values(this.lanes.canvases)) {
        canvas.classList.add('edit-lane')
        this.plot.append(canvas)
      }
    }
    this.plot.append(...Object.values(this.laneBands))
    this.rail = new Rail({ hover: (key) => this.setLit(key), pick: (key) => this.pick(key) })
    this.plot.append(this.rail.element)
    this.learned = props.store.learned

    this.readoutEl = el('div', { class: 'edit-readout', attrs: { 'aria-live': 'polite' } })
    const fitButton = iconButton('maximize', 'Show the whole assembly (0, or a double click)', () => this.fit(), {
      class: 'btn btn-icon',
      size: 15,
    })
    const zoomOut = iconButton('zoom-out', 'Zoom out (−)', () => this.zoomBy(2), { class: 'btn btn-icon', size: 15 })
    const zoomIn = iconButton('zoom-in', 'Zoom in (+)', () => this.zoomBy(0.5), { class: 'btn btn-icon', size: 15 })
    this.undoButton = iconButton('undo-2', 'Undo the last step (⌘Z)', () => props.store.undo(), {
      class: 'btn btn-icon',
      size: 15,
    })
    this.redoButton = iconButton('redo-2', 'Redo it (⇧⌘Z)', () => props.store.redo(), {
      class: 'btn btn-icon',
      size: 15,
    })
    const toolbar = el(
      'div',
      { class: 'edit-toolbar' },
      el('div', { class: 'edit-tools' }, fitButton, zoomOut, zoomIn),
      this.readoutEl,
      el('div', { class: 'edit-tools' }, this.undoButton, this.redoButton),
    )
    this.reviewBar = el('div', { class: 'edit-review hidden', attrs: { 'aria-live': 'polite' } })
    this.root = el('div', { class: 'edit-stage' }, toolbar, this.reviewBar, this.plot)

    this.selectionCard = el('section', { class: 'edit-card' })
    this.historyCard = el('section', { class: 'edit-card' })
    this.sequencesCard = el('section', { class: 'edit-card edit-sequences-card' })
    this.pictureCard = el('section', { class: 'edit-card edit-picture-card' })
    this.suggestionsCard = el('section', { class: 'edit-card edit-suggestions-card' })
    this.genomeCard = el('section', { class: 'edit-card edit-genome-card' })
    this.exportCard = new ExportCard({
      title: props.title,
      store: props.store,
      ...(props.lanes === undefined
        ? {}
        : { annotations: { store: props.lanes.store, ...(props.lanes.client === undefined ? {} : { client: props.lanes.client }) } }),
      ...(props.liftContacts === undefined ? {} : { liftContacts: props.liftContacts }),
      ...(props.binning === undefined ? {} : { binning: props.binning }),
    })
    const mode = (name: Mode, title: string): HTMLButtonElement =>
      el('button', {
        class: 'btn btn-toggle',
        text: name,
        title,
        attrs: { type: 'button', 'aria-pressed': String(name === 'manual') },
        on: { click: () => this.setMode(name) },
      })
    this.modes = {
      manual: mode('manual', 'The suggestions are guides — drawn, labelled, snapped to — and never apply themselves'),
      review: mode('review', 'Work through the suggestions, best first: Y takes one, N turns it down, and every answer teaches the ranking'),
      auto: mode('auto', `Apply every suggestion at ${percent(AUTO_THRESHOLD)} or more, best first — each a step to undo like any other`),
    }
    this.side = el(
      'div',
      { class: 'edit-side-body' },
      el('div', { class: 'edit-modes', attrs: { role: 'group', 'aria-label': 'Who presses accept' } }, ...Object.values(this.modes)),
      this.suggestionsCard,
      ...(props.store.edit.original.genome === undefined ? [] : [this.genomeCard]),
      this.selectionCard,
      this.historyCard,
      this.sequencesCard,
      this.exportCard.element,
      this.pictureCard,
    )

    this.wireCanvas()
    this.wireBar(this.topBar, 'top')
    this.wireBar(this.leftBar, 'left')
    this.onKey = (event) => this.key(event)
    this.onKeyUp = (event) => this.keyUp(event)
    this.onBlur = () => this.letGo()
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('blur', this.onBlur)
    this.stopStore = props.store.subscribe(() => this.edited())

    this.modal = stageDialog({
      // One genome of a metagenome is edited on its own (§27.10), and says so.
      title: props.store.edit.original.genome === undefined ? `Edit the reference · ${props.title}` : `Edit ${props.store.edit.original.genome} · ${props.title}`,
      variant: 'modal-edit',
      stage: this.root,
      stageClass: 'edit-stage-body',
      side: this.side,
      sideClass: 'edit-side',
      memoryKey: props.memoryKey,
      scope: 'edit:side',
      onResize: () => this.resized(),
      onEscape: () => this.escape(),
      onClose: () => this.teardown(),
    })

    this.observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resized())
    this.observer?.observe(this.plot)
    this.paintSide()
    this.read()
    requestAnimationFrame(() => this.resized())
  }

  /** Close the stage, as its ✕ does. */
  close(): void {
    this.modal.close()
  }

  // -------------------------------------------------------------------------
  // The picture
  // -------------------------------------------------------------------------

  /**
   * The picture's size, chosen: a coarser picture is read faster over a slow
   * link and weighed faster, and a zoom past its cell reads the window on
   * screen finer anyway (§27.9).
   */
  private cellsChoice(): HTMLElement {
    const select = el('select', {
      class: 'select edit-cells-select',
      attrs: { 'aria-label': 'Cells a side of the picture' },
      on: { change: () => this.setCells(Number(select.value)) },
    }) as HTMLSelectElement
    for (const cells of PICTURE_CELL_CHOICES) {
      select.append(el('option', { text: `${cells.toLocaleString('en-US')}${cells === PICTURE_CELL_CHOICES[0] ? ' (the finest)' : ''}`, attrs: { value: String(cells) } }))
    }
    select.value = String(this.cells())
    select.disabled = this.request !== null
    return el('label', { class: 'edit-cells' }, el('span', { text: 'cells a side' }), select)
  }

  private read(): void {
    this.request?.cancel()
    const genome = this.props.store.edit.original.genome
    const reading = genome === undefined ? 'reading the whole map for the stage' : `reading ${genome}’s contigs for the stage`
    this.showStatus(`${reading}…`, 0, true)
    const contigs = this.drawnContigs()
    // What the pass reads, as the worker says it on the way in (§27.12): the
    // stored pixels and the resolution, so a long read is a known one.
    let what = ''
    const request = this.props.readPicture(
      (done, total, note) => {
        if (note !== undefined) what = note
        if (this.request === request && total > 0) this.showStatus(what === '' ? `${reading}…` : `${reading}: ${what}…`, done / total, true)
      },
      contigs,
      this.cells(),
    )
    this.request = request
    request.promise
      .then((picture) => {
        if (this.closed || this.request !== request) return
        this.request = null
        this.picture = picture
        this.drawn = contigs === undefined ? null : new Set(contigs)
        this.method = picture.method ?? null
        this.methodKept = picture.methodKept ?? null
        this.layout = { binsize: picture.binsize, sequences: picture.sequences }
        this.colours = pictureColours(this.props.colormap, { low: picture.low, high: picture.high }, picture.vmin, picture.vmax)
        this.hideStatus()
        this.rebuild(true)
        this.countNow()
        this.paintSide()
        void this.readEvidence()
        if (this.props.genomeLinks?.auto === true && this.linksOf !== this.linksKey()) this.readLinks()
      })
      .catch((error: unknown) => {
        if (this.closed || this.request !== request) return
        this.request = null
        const cancelled = error instanceof Error && error.name === 'AbortError'
        this.showStatus(
          cancelled ? 'The picture was not read.' : `The picture could not be read: ${error instanceof Error ? error.message : String(error)}`,
          null,
          false,
        )
      })
  }

  /**
   * The session's sequence read for what it says about the assembly — the
   * telomeres at its ends, the gaps of `N` inside it — and the suggestions
   * counted again with it (§27.5). Nothing where the session has no sequence.
   */
  private async readEvidence(): Promise<void> {
    const lanes = this.props.lanes
    const client = lanes?.client
    const entry = lanes?.store.entries.find((candidate) => candidate.kind === 'sequence' && candidate.status === 'ready')
    const original = this.props.store.edit.original
    if (client === undefined || entry === undefined || this.readingEvidence) return
    this.readingEvidence = true
    this.paintPicture()
    try {
      const evidence = await readSequenceEvidence(
        entry.source.name,
        original.names,
        original.lengths,
        async (sequence, start, end) => {
          const got = await client.request<'bases'>({ kind: 'bases', entry: entry.id, regions: [{ contig: sequence, start, end }] })
          return got.regions[0]?.bases ?? null
        },
        { cancelled: () => this.closed },
      )
      if (evidence === null || this.closed) return
      this.evidence = evidence
      this.countNow()
      this.paintSide()
      this.schedule()
    } catch {
      // A sequence that cannot be read is no evidence either way.
    } finally {
      this.readingEvidence = false
      if (!this.closed) this.paintPicture()
    }
  }

  private showStatus(text: string, fraction: number | null, cancellable: boolean): void {
    const bar = el('div', { class: 'edit-status-bar' })
    if (fraction !== null) bar.append(el('div', { class: 'edit-status-fill', style: { width: `${Math.round(fraction * 100)}%` } }))
    const children: HTMLElement[] = [el('div', { class: 'edit-status-text', text: fraction === null ? text : `${text} ${Math.round(fraction * 100)}%` })]
    if (fraction !== null) children.push(bar)
    if (cancellable) {
      children.push(el('button', { class: 'btn', text: 'cancel', attrs: { type: 'button' }, on: { click: () => this.request?.cancel() } }))
    } else {
      children.push(el('button', { class: 'btn', text: 'read it again', attrs: { type: 'button' }, on: { click: () => this.read() } }))
    }
    this.statusEl.replaceChildren(...children)
    this.statusEl.classList.remove('hidden')
  }

  private hideStatus(): void {
    this.statusEl.classList.add('hidden')
    this.statusEl.replaceChildren()
  }

  // -------------------------------------------------------------------------
  // The edit
  // -------------------------------------------------------------------------

  /** The store changed: a step made, undone or redone. */
  private edited(): void {
    // An adjusted suggestion was for the edit as it stood; so was a finer read.
    this.adjustments.clear()
    this.editVersion++
    this.windowRead = null
    this.windowRequest?.cancel()
    this.windowRequest = null
    // A contig brought in from another genome is not in the picture yet: it
    // is read again, with it (§27.10).
    const drawn = this.drawn
    if (drawn !== null && this.request === null && (this.drawnContigs() ?? []).some((name) => !drawn.has(name))) {
      this.read()
      return
    }
    this.rebuild(false)
    this.paintSide()
    this.scheduleSuggestions()
  }

  /** The sequences the picture is of, where not the whole map: a genome's contigs and those it may bring in. */
  private drawnContigs(): string[] | undefined {
    const original = this.props.store.edit.original
    if (original.genome === undefined) return undefined
    return [...original.names, ...(original.elsewhere ?? []).map((contig) => contig.name)]
  }

  /** The contigs a genome's links are read for: its own and those brought in. */
  private linksKey(): string {
    const original = this.props.store.edit.original
    const brought = this.props.store.assembly.sequences.flatMap((sequence) => sequence.parts.flatMap((part) => (isGap(part) ? [] : [part.sequence])))
    return [...new Set([...original.names, ...brought])].sort().join('\n')
  }

  /** Read every contact for where the genome's contigs and the others belong (§27.10). */
  private readLinks(): void {
    const links = this.props.genomeLinks
    if (links === undefined || this.closed) return
    this.linksRequest?.cancel()
    const key = this.linksKey()
    this.linksDone = 0
    const request = links.read(key.split('\n'), (done, total) => {
      if (this.linksRequest !== request || !(total > 0)) return
      this.linksDone = done / total
      this.paintGenome()
    })
    this.linksRequest = request
    this.paintGenome()
    request.promise
      .then((result) => {
        if (this.closed || this.linksRequest !== request) return
        this.links = result
        this.linksOf = key
      })
      .catch(() => {
        // Cancelled, or the file would not be read: the card says to read again.
      })
      .finally(() => {
        if (this.linksRequest !== request) return
        this.linksRequest = null
        this.linksDone = null
        if (!this.closed) this.paintGenome()
      })
  }

  /** The grid for the store's assembly, keeping the view where it can be kept. */
  private rebuild(first: boolean): void {
    if (this.layout === null) return
    const before = this.grid
    const whole = before === null || (this.sx.domain[0] <= 0 && this.sx.domain[1] >= before.n && this.sy.domain[0] <= 0 && this.sy.domain[1] >= before.n)
    this.grid = LensGrid.of(this.props.store.assembly, this.layout)
    const n = Math.max(1, this.grid.n)
    const x = this.sx.domain
    const y = this.sy.domain
    this.sx.setFull([0, n])
    this.sy.setFull([0, n])
    if (!first && !whole) {
      this.sx.setDomain(x)
      this.sy.setDomain(y)
      this.clampView()
    }
    if (this.selection !== null && !this.selectionFits(this.selection)) this.selection = null
    this.pictureDirty = true
    this.schedule()
  }

  private selectionFits(selection: Selection): boolean {
    const assembly = this.props.store.assembly
    const fits = (stretch: Stretch): boolean => {
      const length = assembly.lengthOf(stretch.sequence)
      return length !== null && stretch.to <= length && stretch.from < stretch.to
    }
    return selection.kind === 'stretch' ? fits(selection.stretch) : fits(selection.rows) && fits(selection.cols)
  }

  /** Make a step, and have the selection follow what it moved. */
  private step(step: EditStep): void {
    const before = this.props.store.assembly
    this.props.store.apply(step)
    const after = this.props.store.assembly
    const followed = landed(before, after, step)
    this.selection = followed === null ? (step.op === 'cut' ? this.selection : null) : { kind: 'stretch', stretch: followed }
    if (this.selection !== null && !this.selectionFits(this.selection)) this.selection = null
    this.paintSide()
    this.schedule()
  }

  /** Steps made one after another, each named against the assembly the one before left. */
  private steps(make: Array<(assembly: EditedAssembly) => EditStep | null>): void {
    for (const next of make) {
      const step = next(this.props.store.assembly)
      if (step !== null) this.props.store.apply(step)
    }
    this.selection = null
    this.paintSide()
    this.schedule()
  }

  // -------------------------------------------------------------------------
  // The acts
  // -------------------------------------------------------------------------

  private turn(stretch: Stretch): void {
    this.step({ op: 'invert', sequence: stretch.sequence, from: stretch.from, to: stretch.to })
  }

  private copy(stretch: Stretch): void {
    this.step({ op: 'duplicate', sequence: stretch.sequence, from: stretch.from, to: stretch.to, into: stretch.sequence, at: stretch.to, strand: 1 })
  }

  private setAside(stretch: Stretch, why: AsideReason): void {
    this.step({ op: 'aside', sequence: stretch.sequence, from: stretch.from, to: stretch.to, why })
  }

  /** The reasons a stretch can be set aside for, as a menu. */
  private asideMenu(stretch: Stretch, x: number, y: number): void {
    openMenu(x, y, [
      { label: `set aside ${formatLocus({ contig: stretch.sequence, start: stretch.from, end: stretch.to })} as` },
      ...REASONS.map((reason) => ({ label: reason.label, title: reason.title, run: () => this.setAside(stretch, reason.why) })),
    ])
  }

  /** Where the pointer is, as an edited position, when it is on the map. */
  private pointerPlace(): { sequence: string; at: number } | null {
    const grid = this.grid
    const hover = this.hover
    if (grid === null || hover === null) return null
    const place = grid.place(Math.min(grid.n - 1e-9, Math.max(0, hover.x.unit)))
    if (place === null || place.bp <= 0) return null
    const length = this.props.store.assembly.lengthOf(place.sequence) ?? 0
    const at = Math.round(place.bp)
    return at > 0 && at < length ? { sequence: place.sequence, at } : null
  }

  private cutHere(): void {
    const place = this.pointerPlace()
    if (place !== null) {
      this.step({ op: 'cut', sequence: place.sequence, at: place.at })
      return
    }
    const selection = this.selection
    if (selection?.kind !== 'stretch') return
    const { sequence, from, to } = selection.stretch
    this.steps([
      () => ({ op: 'cut', sequence, at: to }),
      () => ({ op: 'cut', sequence, at: from }),
    ])
  }

  private splitHere(): void {
    const place = this.pointerPlace()
    if (place !== null) {
      this.step({ op: 'split', sequence: place.sequence, at: place.at })
      return
    }
    const selection = this.selection
    if (selection?.kind !== 'stretch') return
    this.splitOut(selection.stretch)
  }

  /**
   * Whether an edited sequence is a circle (§8.15): declared one by a layout
   * it was read from, or every part of it a piece of one sequence of the file
   * the reader declared circular, the whole of it — as it is, or started
   * elsewhere by an origin already set.
   */
  private circularOf(name: string): boolean {
    const assembly = this.props.store.assembly
    const sequence = assembly.sequence(name)
    if (sequence === null) return false
    if (sequence.circular === true) return true
    const declared = this.props.circular?.() ?? []
    if (declared.length === 0 || sequence.parts.some((part) => isGap(part))) return false
    const pieces = sequence.parts.filter((part) => !isGap(part)) as Array<{ sequence: string }>
    const of = pieces[0]?.sequence
    if (of === undefined || !declared.includes(of) || pieces.some((piece) => piece.sequence !== of)) return false
    const original = this.props.store.edit.original
    const index = original.names.indexOf(of)
    return index >= 0 && assembly.lengthOf(name) === original.lengths[index]
  }

  /**
   * `O`: a circle started at the pointer — or at the selection's start — its
   * first base there and the rest after it round the circle (§27.4). Said, and
   * nothing done, on a sequence that is not one.
   */
  private originHere(): void {
    const selection = this.selection
    const place = this.pointerPlace() ?? (selection?.kind === 'stretch' && selection.stretch.from > 0 ? { sequence: selection.stretch.sequence, at: selection.stretch.from } : null)
    if (place === null) return
    if (!this.circularOf(place.sequence)) {
      this.readoutEl.textContent = `O starts a circle elsewhere, and ${place.sequence} is not one: tick it circular on the Chromosomes table first`
      return
    }
    this.step({ op: 'rotate', sequence: place.sequence, at: place.at })
  }

  /** A stretch made a sequence of its own: split after it, then before it. */
  private splitOut(stretch: Stretch): void {
    const index = this.props.store.assembly.sequences.findIndex((sequence) => sequence.name === stretch.sequence)
    if (index < 0) return
    this.steps([
      (assembly) => {
        const length = assembly.lengthOf(stretch.sequence) ?? 0
        return stretch.to < length ? { op: 'split', sequence: stretch.sequence, at: stretch.to } : null
      },
      (assembly) => {
        // The split may have renamed it: it is at the same place in the order.
        const name = assembly.sequences[index]?.name
        return name === undefined || stretch.from === 0 ? null : { op: 'split', sequence: name, at: stretch.from }
      },
    ])
  }

  /** Two stretches of one sequence, each taking the other's place. */
  private swap(rows: Stretch, cols: Stretch): void {
    if (rows.sequence !== cols.sequence) return
    const [first, second] = rows.from <= cols.from ? [rows, cols] : [cols, rows]
    if (first.to > second.from) return
    const index = this.props.store.assembly.sequences.findIndex((sequence) => sequence.name === first.sequence)
    const gap = second.from - first.to
    this.steps([
      () => ({ op: 'move', sequence: first.sequence, from: second.from, to: second.to, into: first.sequence, at: first.from, strand: 1 }),
      (assembly) => {
        const name = assembly.sequences[index]?.name
        if (name === undefined) return null
        const moved = second.to - second.from
        const from = first.from + moved
        const to = from + (first.to - first.from)
        // After the stretch between, where the second one was: measured with
        // the first taken out.
        return { op: 'move', sequence: name, from, to, into: name, at: from + gap, strand: 1 }
      },
    ])
  }

  // -------------------------------------------------------------------------
  // The view
  // -------------------------------------------------------------------------

  private resized(): void {
    if (this.closed) return
    this.layoutPlot()
    this.pictureDirty = true
    this.schedule()
  }

  /** Place the map, its bars and its lanes in the plot's box. */
  private layoutPlot(): void {
    const box = this.plot.getBoundingClientRect()
    const thickness = (edge: 'top' | 'right' | 'bottom' | 'left'): number => this.lanes?.thicknessOf(edge) ?? 0
    const top = thickness('top')
    const right = thickness('right')
    const bottom = thickness('bottom')
    const left = thickness('left')
    // The rail takes the room left of the map and its lanes (§27.3).
    const rail = RAIL_WIDTH
    const size = Math.max(
      160,
      Math.floor(Math.min(box.width - rail - left - BAR_THICKNESS - right - 12, box.height - top - BAR_THICKNESS - bottom - 12)),
    )
    this.size = size
    this.dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const x = Math.max(0, Math.floor((box.width - (rail + left + BAR_THICKNESS + size + right)) / 2)) + rail + left + BAR_THICKNESS
    const y = top + BAR_THICKNESS + 4
    const place = (node: HTMLElement, px: number, py: number, width: number, height: number): void => {
      node.style.left = `${px}px`
      node.style.top = `${py}px`
      node.style.width = `${width}px`
      node.style.height = `${height}px`
    }
    for (const canvas of [this.pictureCanvas, this.overlayCanvas]) {
      place(canvas, x, y, size, size)
      canvas.width = Math.round(size * this.dpr)
      canvas.height = Math.round(size * this.dpr)
    }
    place(this.topBar, x, y - BAR_THICKNESS, size, BAR_THICKNESS)
    this.topBar.width = Math.round(size * this.dpr)
    this.topBar.height = Math.round(BAR_THICKNESS * this.dpr)
    place(this.leftBar, x - BAR_THICKNESS, y, BAR_THICKNESS, size)
    this.leftBar.width = Math.round(BAR_THICKNESS * this.dpr)
    this.leftBar.height = Math.round(size * this.dpr)
    if (this.lanes !== null) {
      const canvases = this.lanes.canvases
      canvases.top.style.left = `${x}px`
      canvases.top.style.top = `${y - BAR_THICKNESS - top}px`
      canvases.bottom.style.left = `${x}px`
      canvases.bottom.style.top = `${y + size}px`
      canvases.left.style.left = `${x - BAR_THICKNESS - left}px`
      canvases.left.style.top = `${y}px`
      canvases.right.style.left = `${x + size}px`
      canvases.right.style.top = `${y}px`
    }
    this.rail.place(x - BAR_THICKNESS - left - rail, y, rail - 4, size, this.dpr)
    this.railSignature = ''
    this.mapAt = { x, y }
    this.sx.setPixels(size)
    this.sy.setPixels(size)
    this.image = null
  }

  private fit(): void {
    const grid = this.grid
    if (grid === null) return
    this.sx.setDomain([0, Math.max(1, grid.n)])
    this.sy.setDomain([0, Math.max(1, grid.n)])
    this.pictureDirty = true
    this.schedule()
  }

  /** Zoom both axes by `factor` about a point, in units — the middle of the view by default. */
  private zoomBy(factor: number, about?: { x: number; y: number }): void {
    const grid = this.grid
    if (grid === null) return
    const [x0, x1] = this.sx.domain
    const [y0, y1] = this.sy.domain
    const span = Math.min(grid.n, Math.max(MIN_SPAN, (x1 - x0) * factor))
    const cx = about?.x ?? (x0 + x1) / 2
    const cy = about?.y ?? (y0 + y1) / 2
    const kx = (cx - x0) / (x1 - x0)
    const ky = (cy - y0) / (y1 - y0)
    this.sx.setDomain([cx - kx * span, cx - kx * span + span])
    this.sy.setDomain([cy - ky * span, cy - ky * span + span])
    this.clampView()
    this.pictureDirty = true
    this.schedule()
  }

  private clampView(): void {
    const n = Math.max(1, this.grid?.n ?? 1)
    for (const scale of [this.sx, this.sy]) {
      const [d0, d1] = scale.domain
      const span = Math.min(n, d1 - d0)
      let start = d0
      if (start < 0) start = 0
      if (start + span > n) start = n - span
      scale.setDomain([start, start + span])
    }
  }

  /** Frame a stretch of the axis, with a little room either side. */
  private frameUnits(a: number, b: number): void {
    const grid = this.grid
    if (grid === null) return
    const span = Math.min(grid.n, Math.max(MIN_SPAN, (b - a) * 1.25))
    const centre = (a + b) / 2
    this.sx.setDomain([centre - span / 2, centre + span / 2])
    this.sy.setDomain([centre - span / 2, centre + span / 2])
    this.clampView()
    this.pictureDirty = true
    this.schedule()
  }

  /**
   * How many cells a side the picture may have, as the reader set it on the
   * picture card (§27.3's settings, the resolution the stage works at): the
   * finest rung that fits them is read. Kept per file, beside the edit.
   */
  private cells(): number {
    const kept = recall<number>(this.props.memoryKey(), PICTURE_CELLS_SCOPE)
    return typeof kept === 'number' && PICTURE_CELL_CHOICES.includes(kept) ? kept : PICTURE_CELL_CHOICES[0]
  }

  private setCells(cells: number): void {
    if (cells === this.cells()) return
    remember(this.props.memoryKey(), PICTURE_CELLS_SCOPE, cells === PICTURE_CELL_CHOICES[0] ? null : cells)
    this.windowRead = null
    this.read()
  }

  /** A picture cell's width on screen, in CSS pixels. */
  private cellPx(): number {
    const [x0, x1] = this.sx.domain
    return this.size / Math.max(1e-9, x1 - x0)
  }

  private windowKey(): string {
    return `${this.token}:${this.editVersion}`
  }

  /** Once the view has settled, read the window on screen finer than the picture, where it is zoomed past a cell (§27.9). */
  private considerWindow(): void {
    window.clearTimeout(this.windowTimer)
    if (this.props.readWindow === undefined || this.closed) return
    this.windowTimer = window.setTimeout(() => this.readWindow(), 200)
  }

  private readWindow(): void {
    const grid = this.grid
    const picture = this.picture
    const ask = this.props.readWindow
    if (grid === null || picture === null || ask === undefined || this.closed || this.preview !== null || this.drag !== null) return
    const cellPx = this.cellPx()
    if (cellPx < WINDOW_CELL_PX) return
    const [x0, x1] = this.sx.domain
    const [y0, y1] = this.sy.domain
    // A bin a device pixel — finer shows nothing more — and never finer than
    // the map is deep enough to show; and only where that is half a cell or
    // less, since a read about as coarse as the picture shows the picture.
    const bpPerPixel = Math.max(1, Math.floor(picture.binsize / (cellPx * this.dpr)), picture.least ?? 0)
    if (2 * bpPerPixel > picture.binsize) return
    const key = this.windowKey()
    const held = this.windowRead
    const inside = (view: readonly number[]): boolean => view[0] <= x0 && view[1] >= x1 && view[2] <= y0 && view[3] >= y1
    // Held already: this edit, the view inside it, and as fine as asked or the finest there is.
    if (held !== null && held.key === key && inside(held.view) && (held.read.binsize <= 2 * bpPerPixel || held.read.binsize > held.asked)) return
    const padX = (x1 - x0) / 3
    const padY = (y1 - y0) / 3
    const view: [number, number, number, number] = [x0 - padX, x1 + padX, y0 - padY, y1 + padY]
    const rows = this.windowSideOf(grid, view[2], view[3])
    const cols = this.windowSideOf(grid, view[0], view[1])
    if (rows === null || cols === null) return
    this.windowRequest?.cancel()
    const request = ask({ edit: this.props.store.edit, key, binsize: bpPerPixel, coarser: picture.binsize, rows, cols, balance: picture.balanced })
    this.windowRequest = request
    request.promise.then(
      (read) => {
        if (this.closed || this.windowRequest !== request) return
        this.windowRequest = null
        if (read === null || key !== this.windowKey()) return
        this.windowRead = { key, read, view, asked: bpPerPixel }
        this.pictureDirty = true
        this.schedule()
        this.paintPicture()
      },
      () => {
        if (this.windowRequest === request) this.windowRequest = null
      },
    )
  }

  /** A stretch of the axis as the places in the edited assembly it begins and ends at. */
  private windowSideOf(grid: LensGrid, from: number, to: number): StageWindowSide | null {
    const lo = Math.max(0, from)
    const hi = Math.min(grid.n, to)
    if (!(hi > lo)) return null
    const first = grid.place(lo)
    const last = grid.place(Math.max(lo, hi - 1e-6))
    if (first === null || last === null) return null
    return { from: { sequence: first.sequence, bp: Math.max(0, first.bp) }, to: { sequence: last.sequence, bp: Math.max(0, last.bp) } }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.frame !== 0 || this.closed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  /** The grid on screen: the preview while a drag has one, else the edit's. */
  private get shown(): LensGrid | null {
    return this.preview?.grid ?? this.grid
  }

  private draw(): void {
    const grid = this.shown
    if (this.size === 0) this.layoutPlot()
    this.ink ??= readInk(this.root)
    const ink = this.ink
    const size = this.size
    const dpr = this.dpr
    const picture = this.picture
    if (grid === null || picture === null || this.colours === null) return

    if (this.pictureDirty) {
      this.pictureDirty = false
      const ctx = this.pictureCanvas.getContext('2d')
      if (ctx !== null) {
        const width = this.pictureCanvas.width
        const height = this.pictureCanvas.height
        if (this.image === null || this.image.width !== width || this.image.height !== height) {
          this.image = ctx.createImageData(width, height)
        }
        const target = new Uint32Array(this.image.data.buffer)
        const [x0, x1] = this.sx.domain
        const [y0, y1] = this.sy.domain
        paintPicture(target, { x0, x1, y0, y1, width, height }, grid.cellMap, grid.cellMap, picture.levels, this.colours)
        // Closer than a cell, the window read finer, where it reaches (§27.9).
        const held = this.windowRead
        if (held !== null && this.preview === null && held.key === this.windowKey() && this.cellPx() >= WINDOW_CELL_PX) {
          const rows = windowSide(grid, y0, y1, height, held.read.rows, held.read.binsize)
          const cols = windowSide(grid, x0, x1, width, held.read.cols, held.read.binsize)
          paintWindow(target, width, rows, cols, held.read, windowScale(picture, held.read.binsize), { low: picture.low, high: picture.high }, this.colours)
        }
        ctx.putImageData(this.image, 0, 0)
        this.considerWindow()
      }
    }

    const toX = (unit: number): number => this.sx.toPixel(unit)
    const toY = (unit: number): number => this.sy.toPixel(unit)
    // Where the view is, on the element — as a map says its locus on its own —
    // so a script driving the stage can point at a place by its unit.
    const [vx0, vx1] = this.sx.domain
    const [vy0, vy1] = this.sy.domain
    this.overlayCanvas.dataset.cells = String(grid.n)
    this.overlayCanvas.dataset.view = [vx0, vx1, vy0, vy1].map((value) => value.toFixed(3)).join(' ')
    const overlay = this.overlayCanvas.getContext('2d')
    const lit = this.litUnits(grid)
    // The suggestions are about the edit as it stands: while a drag or a
    // preview shows another, they are not drawn over it.
    const marks = this.preview === null ? this.marks() : []
    if (overlay !== null) {
      overlay.setTransform(dpr, 0, 0, dpr, 0, 0)
      const box = this.selection?.kind === 'box' && this.drag === null ? this.boxUnits(grid, this.selection) : this.dragBox()
      drawOverlay(overlay, {
        size,
        grid,
        toX,
        toY,
        ink,
        under: (ctx) => drawSuggestions(ctx, { size, toX, toY, ink, marks }),
        square: box === null ? lit : null,
        box,
        cross:
          this.hover === null || (this.drag !== null && this.drag.kind === 'move')
            ? null
            : {
                x: this.hover.x.unit,
                y: this.hover.y.unit,
                snappedX: this.hover.x.target !== null,
                snappedY: this.hover.y.target !== null,
              },
      })
    }

    const mark = this.drag?.kind === 'move' ? this.drag.mark : null
    const ticks = marks.flatMap(({ suggestion, lit: shining }) =>
      [...suggestion.breaks, ...(suggestion.target === null ? [] : [suggestion.target])].map((unit) => ({ unit, lit: shining })),
    )
    const top = this.topBar.getContext('2d')
    if (top !== null) {
      top.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cols = this.selection?.kind === 'box' ? this.boxUnits(grid, this.selection)?.cols ?? null : lit
      drawBar(top, 'top', size, grid, toX, ink, this.drag?.kind === 'box' ? (this.dragBox()?.cols ?? null) : cols, this.preview === null ? mark : null, ticks)
    }
    const left = this.leftBar.getContext('2d')
    if (left !== null) {
      left.setTransform(dpr, 0, 0, dpr, 0, 0)
      const rows = this.selection?.kind === 'box' ? this.boxUnits(grid, this.selection)?.rows ?? null : lit
      drawBar(left, 'left', size, grid, toY, ink, this.drag?.kind === 'box' ? (this.dragBox()?.rows ?? null) : rows, null, ticks)
    }
    this.paintRail(marks, toY, ink)

    if (this.lanes !== null) {
      // The lanes are drawn through whichever grid is on screen, the preview's
      // included, so a track moves with the stretch under the hand.
      if (this.lanesGrid !== grid) {
        this.lanes.setAxes({ rows: grid.axis, cols: grid.axis })
        this.lanesGrid = grid
      }
      this.lanes.draw(this.laneGeometry())
    }
    this.paintLaneBands(lit, toX, toY)
  }

  /**
   * The selection across the lanes, so a stretch is lit on the tracks as it is
   * on the map and the bars (§27.4): along the columns for the stacks above
   * and below, along the rows for the stacks either side.
   */
  private paintLaneBands(lit: [number, number] | null, toX: (unit: number) => number, toY: (unit: number) => number): void {
    const size = this.size
    const { x, y } = this.mapAt
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      const band = this.laneBands[edge]
      const thickness = this.lanes?.thicknessOf(edge) ?? 0
      if (lit === null || thickness === 0) {
        band.classList.add('hidden')
        continue
      }
      const horizontal = edge === 'top' || edge === 'bottom'
      const to = horizontal ? toX : toY
      const a = Math.max(0, to(lit[0]))
      const b = Math.min(size, to(lit[1]))
      if (!(b > a)) {
        band.classList.add('hidden')
        continue
      }
      const across =
        edge === 'top' ? y - BAR_THICKNESS - thickness : edge === 'bottom' ? y + size : edge === 'left' ? x - BAR_THICKNESS - thickness : x + size
      band.style.left = `${horizontal ? x + a : across}px`
      band.style.top = `${horizontal ? across : y + a}px`
      band.style.width = `${horizontal ? b - a : thickness}px`
      band.style.height = `${horizontal ? thickness : b - a}px`
      band.classList.remove('hidden')
    }
  }

  private laneGeometry(): LaneGeometry {
    const size = this.size
    const rect = { x: 0, y: 0, width: size, height: size }
    const hover =
      this.hover === null ? null : { row: Math.floor(this.hover.y.unit), col: Math.floor(this.hover.x.unit) }
    return {
      plot: rect,
      data: rect,
      colScale: this.sx,
      rowScale: this.sy,
      cssWidth: size,
      cssHeight: size,
      hover,
      anchors: null,
      crosshair: this.hover !== null,
      echo: null,
      echoAnchors: null,
      laneEcho: null,
      guide: null,
      border: null,
      handles: false,
      grip: null,
      scaling: null,
      palette: { guide: this.ink?.dim ?? '#555', halo: this.ink?.background ?? '#fff', crosshair: this.ink?.accent ?? '#1f5fa9' },
    }
  }

  /** The selection on the diagonal, in units of the grid shown. */
  private litUnits(grid: LensGrid): [number, number] | null {
    if (this.drag?.kind === 'along') {
      const stretch = stretchBetween(grid, this.drag.anchor, this.alongEnd(this.drag.anchor, this.drag.x, this.drag.y))
      return stretch === null ? null : stretchUnits(grid, stretch)
    }
    if (this.drag?.kind === 'move') {
      if (this.preview !== null) return this.preview.units
      return this.drag.units
    }
    if (this.selection?.kind !== 'stretch') return null
    return stretchUnits(grid, this.selection.stretch)
  }

  private boxUnits(
    grid: LensGrid,
    selection: Extract<Selection, { kind: 'box' }>,
  ): { rows: [number, number]; cols: [number, number] } | null {
    const rows = stretchUnits(grid, selection.rows)
    const cols = stretchUnits(grid, selection.cols)
    return rows === null || cols === null ? null : { rows, cols }
  }

  /** The box being drawn, in units, while a box drag is under way. */
  private dragBox(): { rows: [number, number]; cols: [number, number] } | null {
    const drag = this.drag
    if (drag?.kind !== 'box' || !drag.moved) return null
    const x = this.snapX(this.sx.toUnit(drag.x)).unit
    const y = this.snapY(this.sy.toUnit(drag.y)).unit
    return {
      rows: [Math.min(drag.ay, y), Math.max(drag.ay, y)],
      cols: [Math.min(drag.ax, x), Math.max(drag.ax, x)],
    }
  }

  // -------------------------------------------------------------------------
  // The hand
  // -------------------------------------------------------------------------

  private targets(): SnapTarget[] {
    const grid = this.grid
    if (grid === null) return []
    const out = endTargets(grid)
    if (this.selection?.kind === 'stretch') {
      const units = stretchUnits(grid, this.selection.stretch)
      if (units !== null) out.push({ unit: units[0], kind: 'selection' }, { unit: units[1], kind: 'selection' })
    }
    // Every point a suggestion names: its breakpoints, and where it would put a stretch.
    for (const suggestion of this.open()) {
      for (const unit of suggestion.breaks) out.push({ unit, kind: 'suggestion', key: suggestion.key })
      if (suggestion.target !== null) out.push({ unit: suggestion.target, kind: 'suggestion', key: suggestion.key })
      for (const corner of suggestion.corners) {
        out.push({ unit: corner.row, kind: 'suggestion', key: suggestion.key }, { unit: corner.col, kind: 'suggestion', key: suggestion.key })
      }
    }
    return out
  }

  private snapX(unit: number): Snapped {
    return snapUnit(unit, this.targets(), SNAP_PX * this.sx.unitsPerPixel, this.alt)
  }

  private snapY(unit: number): Snapped {
    return snapUnit(unit, this.targets(), SNAP_PX * this.sy.unitsPerPixel, this.alt)
  }

  /** A pointer position projected onto the diagonal, snapped. */
  private alongUnit(px: number, py: number): Snapped {
    return this.snapX((this.sx.toUnit(px) + this.sy.toUnit(py)) / 2)
  }

  /**
   * The far end of a drag along the diagonal: snapped, unless it would snap
   * onto the very target the drag began at — at the whole-genome scale eight
   * pixels are a hundred kilobases, and a stretch that small near a sequence's
   * edge would otherwise come out empty however far the hand went.
   */
  private alongEnd(anchor: number, px: number, py: number): number {
    const snapped = this.alongUnit(px, py).unit
    return snapped === anchor ? Math.round((this.sx.toUnit(px) + this.sy.toUnit(py)) / 2) : snapped
  }

  private wireCanvas(): void {
    const canvas = this.overlayCanvas
    const local = (event: MouseEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (this.grid === null) return
      canvas.focus({ preventScroll: true })
      closeMenu()
      const { x, y } = local(event)
      if (event.button === 1 || (event.button === 0 && this.space)) {
        this.drag = { kind: 'pan', x, y }
      } else if (event.button === 0 && this.endUnder(x, y) !== null) {
        const grab = this.endUnder(x, y) as { key: string; end: 0 | 1 }
        this.drag = { kind: 'adjust', ...grab, x, y, moved: false }
      } else if (event.button === 0) {
        this.alt = event.altKey
        const ux = this.sx.toUnit(x)
        const uy = this.sy.toUnit(y)
        const lit = this.selection?.kind === 'stretch' ? stretchUnits(this.grid, this.selection.stretch) : null
        const diagonal = Math.abs(x - y - (this.sx.toPixel(0) - this.sy.toPixel(0))) / Math.SQRT2
        if (lit !== null && ux >= lit[0] && ux <= lit[1] && uy >= lit[0] && uy <= lit[1] && this.selection?.kind === 'stretch') {
          const along = (ux + uy) / 2
          this.drag = {
            kind: 'move',
            stretch: this.selection.stretch,
            units: lit,
            grip: along - lit[0],
            x,
            y,
            moved: false,
            strand: 1,
            copy: event.altKey,
            step: null,
            mark: null,
          }
        } else if (diagonal <= DIAGONAL_PX) {
          this.drag = { kind: 'along', anchor: this.alongUnit(x, y).unit, x, y, moved: false }
        } else {
          this.drag = { kind: 'box', ax: this.snapX(ux).unit, ay: this.snapY(uy).unit, x, y, moved: false }
        }
      } else {
        return
      }
      canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      this.schedule()
    })
    canvas.addEventListener('pointermove', (event) => {
      const { x, y } = local(event)
      this.alt = event.altKey
      this.pointAt(x, y)
      const drag = this.drag
      if (drag === null) return
      if (drag.kind === 'pan') {
        this.sx.panByPixels(x - drag.x)
        this.sy.panByPixels(y - drag.y)
        this.clampView()
        drag.x = x
        drag.y = y
        this.pictureDirty = true
      } else {
        // Until it has travelled, `x` and `y` are where the press was.
        if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < DRAG_PX) return
        drag.moved = true
        drag.x = x
        drag.y = y
        if (drag.kind === 'move') {
          drag.copy = event.altKey
          this.updateMove(drag)
        } else if (drag.kind === 'adjust') {
          this.updateAdjust(drag)
        }
      }
      this.schedule()
    })
    const finish = (event: PointerEvent): void => {
      const drag = this.drag
      if (drag === null) return
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      this.drag = null
      const grid = this.grid
      if (grid === null) return
      const { x, y } = local(event)
      if (drag.kind === 'along') {
        const unit = this.alongEnd(drag.anchor, x, y)
        const stretch = drag.moved ? stretchBetween(grid, drag.anchor, unit) : partStretch(grid, (this.sx.toUnit(x) + this.sy.toUnit(y)) / 2)
        this.selection = stretch === null ? null : { kind: 'stretch', stretch }
      } else if (drag.kind === 'box') {
        const cx = this.snapX(this.sx.toUnit(x)).unit
        const cy = this.snapY(this.sy.toUnit(y)).unit
        if (drag.moved) {
          const rows = stretchBetween(grid, drag.ay, cy)
          const cols = stretchBetween(grid, drag.ax, cx)
          this.selection = rows !== null && cols !== null ? { kind: 'box', rows, cols } : null
        } else {
          // A press on a corner names the stretch between its two ends (§27.4),
          // where both are in one sequence; two parts boxed where they are not.
          const same = grid.sequenceAt(cx) !== null && grid.sequenceAt(cx) === grid.sequenceAt(cy)
          if (same) {
            const stretch = stretchBetween(grid, Math.min(cx, cy), Math.max(cx, cy))
            this.selection = stretch === null ? null : { kind: 'stretch', stretch }
          } else {
            const rows = partStretch(grid, this.sy.toUnit(y))
            const cols = partStretch(grid, this.sx.toUnit(x))
            this.selection = rows !== null && cols !== null ? { kind: 'box', rows, cols } : null
          }
        }
      } else if (drag.kind === 'adjust') {
        // Kept as the hand left it, to be answered: nothing is made until it is taken.
        this.paintReadout()
      } else if (drag.kind === 'move') {
        const step = drag.moved ? drag.step : null
        this.preview = null
        this.pictureDirty = true
        if (step !== null) {
          this.step(step)
          return
        }
      }
      this.paintSide()
      this.schedule()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      this.cancelDrag()
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.drag !== null) return
      this.hover = null
      this.setLit(null)
      this.paintReadout()
      this.schedule()
    })
    canvas.addEventListener('dblclick', (event) => {
      event.preventDefault()
      this.fit()
    })
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (this.grid === null) return
        event.preventDefault()
        const { x, y } = local(event)
        if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          const dx = event.shiftKey ? event.deltaY : event.deltaX
          this.sx.panByPixels(-dx)
          this.sy.panByPixels(-dx)
          this.clampView()
          this.pictureDirty = true
          this.schedule()
          return
        }
        const factor = Math.exp(event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002))
        this.zoomBy(factor, { x: this.sx.toUnit(x), y: this.sy.toUnit(y) })
      },
      { passive: false },
    )
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const { x, y } = local(event)
      this.pointAt(x, y)
      openMenu(event.clientX, event.clientY, this.menuItems(event.clientX, event.clientY))
    })
  }

  /**
   * A pieces bar as a handle on the pieces it draws (§27.3, §27.4): a press
   * selects the piece under it, or holds the selection where it is inside it,
   * and a drag moves what is held — the map's own move, with the pointer set
   * on the diagonal at the bar's place, so the ghost, the snapping, the preview
   * under the hand, `I` on the way and ⌥ for a copy are the same ones; a
   * double click turns the piece; hovering names it and where it came from.
   */
  private wireBar(canvas: HTMLCanvasElement, side: 'top' | 'left'): void {
    const unitOf = (event: MouseEvent): number => {
      const rect = canvas.getBoundingClientRect()
      return side === 'top' ? this.sx.toUnit(event.clientX - rect.left) : this.sy.toUnit(event.clientY - rect.top)
    }
    const onDiagonal = (unit: number): { x: number; y: number } => ({ x: this.sx.toPixel(unit), y: this.sy.toPixel(unit) })
    canvas.addEventListener('pointerdown', (event) => {
      const grid = this.grid
      if (grid === null || event.button !== 0) return
      closeMenu()
      this.overlayCanvas.focus({ preventScroll: true })
      const unit = unitOf(event)
      const held = this.selection?.kind === 'stretch' ? this.selection.stretch : null
      const lit = held === null ? null : stretchUnits(grid, held)
      const inside = held !== null && lit !== null && unit >= lit[0] && unit <= lit[1]
      const stretch = inside ? held : partStretch(grid, unit)
      if (stretch === null) return
      const units = inside && lit !== null ? lit : stretchUnits(grid, stretch)
      if (!inside) {
        this.selection = { kind: 'stretch', stretch }
        this.paintSide()
      }
      if (units !== null) {
        this.drag = { kind: 'move', stretch, units, grip: unit - units[0], ...onDiagonal(unit), moved: false, strand: 1, copy: event.altKey, step: null, mark: null }
        this.barPress = { x: event.clientX, y: event.clientY }
        canvas.setPointerCapture(event.pointerId)
        canvas.classList.add('is-dragging')
      }
      event.preventDefault()
      this.schedule()
    })
    canvas.addEventListener('pointermove', (event) => {
      const drag = this.drag
      if (drag?.kind === 'move' && this.barPress !== null) {
        if (!drag.moved && Math.hypot(event.clientX - this.barPress.x, event.clientY - this.barPress.y) < DRAG_PX) return
        drag.moved = true
        Object.assign(drag, onDiagonal(unitOf(event)))
        drag.copy = event.altKey
        this.updateMove(drag)
        this.schedule()
        return
      }
      if (this.drag === null) this.describeBar(unitOf(event))
    })
    const finish = (event: PointerEvent): void => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      canvas.classList.remove('is-dragging')
      const drag = this.drag
      this.barPress = null
      if (drag?.kind !== 'move') return
      this.drag = null
      const step = drag.moved ? drag.step : null
      this.preview = null
      this.pictureDirty = true
      if (step !== null) {
        this.step(step)
        return
      }
      this.paintReadout()
      this.paintSide()
      this.schedule()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      canvas.classList.remove('is-dragging')
      this.barPress = null
      this.cancelDrag()
    })
    canvas.addEventListener('pointerleave', () => {
      if (this.drag === null) this.paintReadout()
    })
    canvas.addEventListener('dblclick', (event) => {
      event.preventDefault()
      const grid = this.grid
      if (grid === null) return
      const stretch = partStretch(grid, unitOf(event))
      if (stretch !== null) this.turn(stretch)
    })
  }

  /** The readout over a pieces bar: the piece under the pointer, where it came from, and what the bar does with it. */
  private describeBar(unit: number): void {
    const grid = this.grid
    if (grid === null) return
    const place = grid.place(Math.min(grid.n - 1e-9, Math.max(0, unit)))
    const stretch = partStretch(grid, unit)
    const piece = place?.part.piece ?? null
    if (place === null || stretch === null || piece === null) {
      this.readoutEl.textContent = place === null ? this.summary() : `${place.sequence} · gap`
      return
    }
    const here = formatLocus({ contig: stretch.sequence, start: stretch.from, end: stretch.to })
    const from = formatLocus({ contig: piece.sequence, start: piece.start, end: piece.end })
    const origin = from === here && piece.strand === 1 ? '' : ` ← ${from}${piece.strand === -1 ? ', turned' : ''}`
    this.readoutEl.textContent = `${here}${origin} · drag to move it, double-click to turn it`
  }

  /**
   * The pointer at `(x, y)` on the map, snapped, and said in the readout: to a
   * suggestion's corner in the plane where one is within reach (§27.4), else
   * along each axis; and a suggestion's mark under it lit, with its label.
   */
  private pointAt(x: number, y: number): void {
    if (this.grid === null) return
    const spots = this.preview === null && this.drag?.kind !== 'move' ? markSpots({ size: this.size, toX: (u) => this.sx.toPixel(u), toY: (u) => this.sy.toPixel(u), marks: this.marks() }) : []
    let nearest: (typeof spots)[number] | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const spot of spots) {
      const d = Math.hypot(spot.x - x, spot.y - y)
      if (d < distance) {
        nearest = spot
        distance = d
      }
    }
    const within = nearest !== null && distance <= CORNER_PX ? nearest : null
    if (within !== null && within.corner && !this.alt) {
      const target = { kind: 'suggestion' as const, key: within.key }
      this.hover = { x: { unit: within.col, target: { ...target, unit: within.col } }, y: { unit: within.row, target: { ...target, unit: within.row } }, px: x, py: y }
    } else {
      this.hover = { x: this.snapX(this.sx.toUnit(x)), y: this.snapY(this.sy.toUnit(y)), px: x, py: y }
    }
    if (this.drag === null) this.setLit(within?.key ?? this.hover.x.target?.key ?? this.hover.y.target?.key ?? null)
    // An end a drag would take hold of says so under the pointer (§27.6).
    this.overlayCanvas.classList.toggle('is-on-end', this.drag === null && this.endUnder(x, y) !== null)
    this.overlayCanvas.classList.toggle('is-adjusting', this.drag?.kind === 'adjust')
    this.paintReadout()
    this.schedule()
  }

  /** Recompute a move's drop and its preview as the pointer travels. */
  private updateMove(drag: Extract<Drag, { kind: 'move' }>): void {
    const grid = this.grid
    if (grid === null) return
    const along = (this.sx.toUnit(drag.x) + this.sy.toUnit(drag.y)) / 2
    const length = drag.units[1] - drag.units[0]
    // Where the stretch's start would go, snapped by whichever of its two ends
    // is nearer a target — a stretch is dropped against an edge either way.
    const start = along - drag.grip
    const reach = SNAP_PX * this.sx.unitsPerPixel
    const ends = endTargets(grid)
    const byStart = snapUnit(start, ends, reach, this.alt && !drag.copy)
    const byEnd = snapUnit(start + length, ends, reach, this.alt && !drag.copy)
    const unit =
      byEnd.target !== null && (byStart.target === null || Math.abs(byEnd.unit - (start + length)) < Math.abs(byStart.unit - start))
        ? byEnd.unit - length
        : byStart.unit
    // Before the step, a start past the stretch is measured with it still in.
    const at = unit > drag.units[0] ? unit + length : unit
    drag.mark = Math.max(0, Math.min(grid.n, at))
    const place = dropPlace(grid, drag.mark, along)
    const step = place === null ? null : dropStep(this.props.store.assembly, drag.stretch, place, drag.strand, drag.copy)
    drag.step = step
    if (step === null) {
      this.preview = null
    } else {
      const assembly = this.props.store.assembly
      const next = EditedAssembly.of(this.props.store.tentative(step))
      const previewGrid = LensGrid.of(next, this.layout as GridLayout)
      const where = landed(assembly, next, step)
      this.preview = { grid: previewGrid, units: where === null ? null : stretchUnits(previewGrid, where) }
    }
    this.pictureDirty = true
    this.paintReadout()
  }

  private cancelDrag(): boolean {
    if (this.drag === null) return false
    this.drag = null
    this.preview = null
    this.pictureDirty = true
    this.paintReadout()
    this.schedule()
    return true
  }

  /** Escape: the innermost thing in progress, and never the stage. */
  private escape(): void {
    closeMenu()
    if (this.cancelDrag()) return
    if (this.selection !== null) {
      this.selection = null
      this.paintSide()
      this.schedule()
    }
  }

  private key(event: KeyboardEvent): void {
    if (this.closed) return
    const target = event.target as HTMLElement | null
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return
    }
    // Only the dialog on top answers.
    const dialogs = document.querySelectorAll('.modal-backdrop')
    if (dialogs.length > 0 && !dialogs[dialogs.length - 1].contains(this.root)) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    let handled = true
    if (key === 'Alt') {
      this.alt = true
      handled = false
    } else if (key === ' ') {
      this.space = true
      this.overlayCanvas.classList.add('is-panning')
      // In review, held: the map as it would be with the suggestion taken.
      if (this.mode === 'review' && !event.repeat) this.startPreview()
    } else if (mod && (key === 'z' || key === 'Z')) {
      if (event.shiftKey) this.props.store.redo()
      else this.props.store.undo()
    } else if (mod && (key === 'y' || key === 'Y')) {
      this.props.store.redo()
    } else if (mod) {
      handled = false
    } else if (key === 'i' || key === 'I') {
      if (this.drag?.kind === 'move') {
        this.drag.strand = this.drag.strand === 1 ? -1 : 1
        this.updateMove(this.drag)
        this.schedule()
      } else if (this.selection?.kind === 'stretch') {
        this.turn(this.selection.stretch)
      } else handled = false
    } else if (key === 'c' || key === 'C') {
      this.cutHere()
    } else if (key === 's' || key === 'S') {
      this.splitHere()
    } else if (key === 'o' || key === 'O') {
      this.originHere()
    } else if (key === 'Backspace' || key === 'Delete') {
      if (this.selection?.kind === 'stretch') {
        const rect = this.overlayCanvas.getBoundingClientRect()
        this.asideMenu(this.selection.stretch, rect.left + rect.width / 2, rect.top + rect.height / 2)
      } else handled = false
    } else if (key === 'y' || key === 'Y' || key === 'n' || key === 'N') {
      // Review answers the one it is on; elsewhere, the one lit under the hand.
      const suggestion = this.byKey(this.mode === 'review' ? this.current : this.lit)
      if (suggestion === null) handled = false
      else if (key === 'y' || key === 'Y') this.accept(suggestion)
      else this.reject(suggestion)
    } else if (this.mode === 'review' && (key === 'ArrowRight' || key === 'ArrowLeft')) {
      this.moveCurrent(key === 'ArrowRight' ? 1 : -1)
    } else if (key === '0') {
      this.fit()
    } else if (key === '+' || key === '=') {
      this.zoomBy(0.5)
    } else if (key === '-' || key === '_') {
      this.zoomBy(2)
    } else {
      handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  private keyUp(event: KeyboardEvent): void {
    if (event.key === 'Alt') this.alt = false
    if (event.key === ' ') this.letGoOfSpace()
  }

  /** The window left with keys held: no key-up comes for them, so they are let go of here. */
  private letGo(): void {
    this.alt = false
    this.letGoOfSpace()
  }

  private letGoOfSpace(): void {
    this.space = false
    this.overlayCanvas.classList.remove('is-panning')
    this.stopPreview()
  }

  /** The right-click menu: what can be done with what is selected, or here. */
  private menuItems(clientX: number, clientY: number): MenuItem[] {
    const items: MenuItem[] = []
    const selection = this.selection
    if (selection?.kind === 'stretch') {
      const stretch = selection.stretch
      items.push(
        { label: formatLocus({ contig: stretch.sequence, start: stretch.from, end: stretch.to }) },
        { label: 'turn it round', hint: 'I', run: () => this.turn(stretch) },
        { label: 'copy it after itself', run: () => this.copy(stretch) },
        { label: 'make it a sequence of its own', run: () => this.splitOut(stretch) },
        { label: 'set it aside…', hint: 'delete', run: () => this.asideMenu(stretch, clientX, clientY) },
      )
    }
    const place = this.pointerPlace()
    if (place !== null) {
      items.push(
        { label: formatPosition(place.sequence, place.at) },
        { label: 'cut here', hint: 'C', run: () => this.step({ op: 'cut', sequence: place.sequence, at: place.at }) },
        { label: 'split into two sequences here', hint: 'S', run: () => this.step({ op: 'split', sequence: place.sequence, at: place.at }) },
        ...(this.circularOf(place.sequence)
          ? [{ label: 'start the circle here', hint: 'O', run: () => this.step({ op: 'rotate', sequence: place.sequence, at: place.at }) }]
          : []),
      )
    }
    return items
  }

  // -------------------------------------------------------------------------
  // Words
  // -------------------------------------------------------------------------

  /** The line over the map: where the pointer is, or what the drag would do. */
  private paintReadout(): void {
    const grid = this.grid
    const drag = this.drag
    if (drag?.kind === 'move' && drag.moved) {
      this.readoutEl.textContent =
        drag.step === null ? 'drop it here to leave it where it is' : `${stepText(drag.step)}${drag.copy ? '' : ' · ⌥ to copy'} · I to turn it`
      return
    }
    const hover = this.hover
    if (grid === null || hover === null) {
      this.readoutEl.textContent = this.summary()
      return
    }
    const describe = (unit: number): string => {
      const place = grid.place(Math.min(grid.n - 1e-9, Math.max(0, unit)))
      if (place === null) return ''
      const here = formatPosition(place.sequence, Math.floor(place.bp))
      const piece = place.part.piece
      const segment = place.part.segment
      if (piece === null || segment === null) return `${here} · gap`
      const original = Math.floor(Math.max(piece.start, Math.min(piece.end - 1, bpAt(segment, unit))))
      const same = piece.sequence === place.sequence && piece.strand === 1 && original === Math.floor(place.bp)
      return same ? here : `${here} ← ${formatPosition(piece.sequence, original)}${piece.strand === -1 ? ', turned' : ''}`
    }
    const offDiagonal = Math.abs(hover.px - hover.py - (this.sx.toPixel(0) - this.sy.toPixel(0))) > DIAGONAL_PX * Math.SQRT2
    const row = offDiagonal ? describe(hover.y.unit) : ''
    const edge = hover.x.target?.kind === 'end' ? this.edgeName(grid, hover.x.unit) : null
    const col = edge ?? describe(hover.x.unit)
    // A suggestion's point names the suggestion: its number, its kind; a corner
    // is two points at once.
    const onKey = hover.x.target?.kind === 'suggestion' ? hover.x.target.key : hover.y.target?.kind === 'suggestion' ? hover.y.target.key : undefined
    const suggestion = onKey === undefined ? null : this.byKey(onKey)
    const number = suggestion === null ? 0 : this.open().findIndex((open) => open.key === suggestion.key) + 1
    const corner = suggestion !== null && hover.x.target?.kind === 'suggestion' && hover.y.target?.kind === 'suggestion' && offDiagonal
    const snapped =
      suggestion !== null
        ? `${corner ? 'corner of' : 'snapped to'} ${number} · ${KIND_WORD[suggestion.kind]} · `
        : hover.x.target !== null && edge === null
          ? 'edit end · '
          : this.alt
            ? 'free · '
            : ''
    this.readoutEl.textContent = `${snapped}${col}${row === '' ? '' : ` × ${row}`}`
  }

  /**
   * A unit the pointer snapped to, named as the edge between two sequences where
   * it is one — the end of one and the start of the next is one place, and the
   * readout says both — or `null` for a junction inside a sequence.
   */
  private edgeName(grid: LensGrid, unit: number): string | null {
    const before = grid.sequenceAt(unit - 0.5)
    const after = grid.sequenceAt(unit)
    if (before === after) return null
    if (before === null && after !== null) return `the start of ${after.name}`
    if (after === null && before !== null) return `the end of ${before.name}`
    return before !== null && after !== null ? `between ${before.name} and ${after.name}` : null
  }

  private summary(): string {
    const assembly = this.props.store.assembly
    const total = assembly.sequences.reduce((sum, sequence) => sum + (assembly.lengthOf(sequence.name) ?? 0), 0)
    const steps = this.props.store.applied
    return `${assembly.sequences.length.toLocaleString('en-US')} sequences · ${fmt.bp(total)}${steps > 0 ? ` · ${steps} ${steps === 1 ? 'step' : 'steps'}` : ' · as in the file'}`
  }

  // -------------------------------------------------------------------------
  // The sidebar
  // -------------------------------------------------------------------------

  private paintSide(): void {
    this.paintSuggestions()
    this.paintReview()
    this.paintSelection()
    this.paintHistory()
    this.paintSequences()
    this.paintGenome()
    this.paintPicture()
    this.paintReadout()
    const store = this.props.store
    this.undoButton.disabled = !store.canUndo
    this.redoButton.disabled = !store.canRedo
    for (const [name, button] of Object.entries(this.modes) as Array<[Mode, HTMLButtonElement]>) {
      button.setAttribute('aria-pressed', String(name === this.mode))
      button.disabled = name !== 'manual' && this.suggested === null
    }
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  /** The suggestions offered: not turned down, and at the floor or above, best first. */
  private open(): Suggestion[] {
    const rejected = new Set(this.learned.rejected)
    return (this.suggested?.list ?? [])
      .filter((suggestion) => !rejected.has(suggestion.key) && suggestion.confidence >= OFFER_FLOOR)
      .map((suggestion) => this.effective(suggestion))
  }

  /**
   * A suggestion as the hand left it: its ends where they were dragged, the
   * confidence and what it rests on the method's latest count's (§27.6).
   */
  private effective(suggestion: Suggestion): Suggestion {
    const moved = this.adjustments.get(suggestion.key)
    return moved === undefined ? suggestion : { ...moved, confidence: suggestion.confidence, features: suggestion.features, gain: suggestion.gain }
  }

  /**
   * An end of the suggestion review is on within reach of the pointer, that a
   * drag would take hold of (§27.6). In review only: there the suggestion is
   * the one thing being answered, where in manual its ends sit on the very
   * places a selection's square is pressed to move it.
   */
  private endUnder(x: number, y: number): { key: string; end: 0 | 1 } | null {
    if (this.mode !== 'review' || this.preview !== null) return null
    const suggestion = this.byKey(this.current)
    if (suggestion === null) return null
    const ends = adjustableEnds(suggestion)
    for (let i = 0; i < ends.length; i++) {
      if (Math.hypot(this.sx.toPixel(ends[i]) - x, this.sy.toPixel(ends[i]) - y) <= CORNER_PX) return { key: suggestion.key, end: i === 0 ? 0 : 1 }
    }
    return null
  }

  /** An end of a suggestion followed to where the pointer is, snapped along the diagonal (§27.6). */
  private updateAdjust(drag: Extract<Drag, { kind: 'adjust' }>): void {
    const grid = this.grid
    const suggestion = this.byKey(drag.key)
    if (grid === null || suggestion === null) return
    const unit = this.alongUnit(drag.x, drag.y).unit
    const next = adjustSuggestion(grid, suggestion, drag.end, unit)
    if (next !== null) {
      this.adjustments.set(drag.key, next)
      // Dragged past the other end, it is the other end now.
      if (suggestion.stretch !== null && next.stretch !== null) drag.end = unit <= next.stretch[0] ? 0 : 1
    }
    const number = this.open().findIndex((open) => open.key === drag.key) + 1
    this.readoutEl.textContent = `adjusting ${number} · ${(next ?? suggestion).words}${next === null ? ' · not here' : ''}`
    this.railSignature = ''
  }

  /** The ones turned down, which the list strikes through. */
  private declined(): Suggestion[] {
    const rejected = new Set(this.learned.rejected)
    return (this.suggested?.list ?? []).filter((suggestion) => rejected.has(suggestion.key))
  }

  private byKey(key: string | null | undefined): Suggestion | null {
    if (key === null || key === undefined) return null
    const found = this.suggested?.list.find((suggestion) => suggestion.key === key)
    return found === undefined ? null : this.effective(found)
  }

  /** The suggestions as the map draws them, numbered as the rail and the list number them. */
  private marks(): MarkedSuggestion[] {
    return this.open().map((suggestion, i) => ({
      suggestion,
      number: i + 1,
      lit: suggestion.key === this.lit || suggestion.key === this.current,
    }))
  }

  /**
   * Count the suggestions now rather than once the hand has let go: when the
   * picture or the sequence's evidence arrives. Here, the count is in before
   * this returns; kept where it was read, it is on its way.
   */
  private countNow(): void {
    window.clearTimeout(this.suggesting)
    this.suggesting = 0
    void this.recount().then(() => {
      if (this.closed) return
      this.paintSide()
      this.schedule()
    })
  }

  /** Whether there is anything to weigh suggestions against: the method's data here, or kept where it was read. */
  private weighs(): boolean {
    return this.method !== null || (this.methodKept !== null && this.props.suggest !== undefined)
  }

  /** Count the suggestions again once the hand has let go — after an edit, or an answer. */
  private scheduleSuggestions(): void {
    if (!this.weighs() || this.closed) return
    window.clearTimeout(this.suggesting)
    this.suggesting = window.setTimeout(() => {
      this.suggesting = 0
      if (this.closed) return
      void this.recount().then(() => {
        if (this.closed) return
        this.paintSide()
        this.schedule()
      })
    }, 30)
    this.paintSuggestions()
  }

  /**
   * The suggestions for the edit as it stands (§27.5): counted where the
   * method's data is kept — off the stage's thread, so a hand on the map is
   * never held up by them (§27.12) — or here where the picture brought it.
   * Settles once they are in; a count overtaken by another edit is dropped
   * for the one that follows it.
   */
  private recount(): Promise<void> {
    const grid = this.grid
    if (grid === null || this.closed) return Promise.resolve()
    const weights = this.learned.weights ?? INITIAL_WEIGHTS
    if (this.method !== null) {
      this.tookSuggestions(suggest({ ...this.method, grid, weights, ...(this.evidence === null ? {} : { evidence: this.evidence }) }))
      return Promise.resolve()
    }
    const kept = this.methodKept
    const ask = this.props.suggest
    const layout = this.layout
    if (kept === null || ask === undefined || layout === null) return Promise.resolve()
    this.recountRequest?.cancel()
    const edit = this.props.store.edit
    const request = ask({ picture: kept, edit, layout, weights: [...weights], ...(this.evidence === null ? {} : { evidence: this.evidence }) })
    this.recountRequest = request
    this.paintSuggestions()
    return request.promise.then(
      (suggested) => {
        if (this.closed || this.recountRequest !== request) return
        this.recountRequest = null
        if (this.props.store.edit === edit) this.tookSuggestions(suggested)
      },
      () => {
        if (this.recountRequest === request) this.recountRequest = null
      },
    )
  }

  /** A count of the suggestions, taken: the one review is on and the one lit kept where they still are. */
  private tookSuggestions(suggested: Suggested): void {
    this.suggested = suggested
    const open = this.open()
    if (this.current !== null && !open.some((suggestion) => suggestion.key === this.current)) this.current = null
    if (this.mode === 'review' && this.current === null) this.current = open[0]?.key ?? null
    if (this.lit !== null && this.byKey(this.lit) === null) this.lit = null
    this.railSignature = ''
  }

  /** Light a suggestion — its marks, its label and its row at once — or none. */
  private setLit(key: string | null): void {
    if (key === this.lit) return
    this.lit = key
    for (const row of this.suggestionsCard.querySelectorAll<HTMLElement>('.edit-suggestion')) {
      row.classList.toggle('is-lit', row.dataset.key === key)
    }
    this.schedule()
  }

  /** A suggestion pressed, on the rail or in the list: framed, and the one review is on. */
  private pick(key: string): void {
    const suggestion = this.byKey(key)
    if (suggestion === null) return
    if (this.mode === 'review') this.current = key
    this.frameSuggestion(suggestion)
    this.paintSide()
  }

  /** Frame what a suggestion concerns, with room round it to see the evidence. */
  private frameSuggestion(suggestion: Suggestion): void {
    const [a, b] = suggestion.extent
    const room = Math.max(12, (b - a) * 0.4)
    this.frameUnits(a - room, b + room)
  }

  /** Take a suggestion: its step made, with what it rested on kept in the history. */
  private accept(suggestion: Suggestion, by: 'suggestion' | 'auto' = 'suggestion'): void {
    if (by === 'suggestion') this.answer(suggestion, true)
    if (this.current === suggestion.key) this.current = null
    this.selection = null
    this.props.store.apply(suggestion.step, by, `${suggestion.words} · ${percent(suggestion.confidence)} · ${suggestion.evidence.join(', ')}`)
  }

  /** Turn a suggestion down: gone from the map, struck through in the list, and learned from. */
  private reject(suggestion: Suggestion): void {
    this.answer(suggestion, false)
    this.learned = { ...this.learned, rejected: [...this.learned.rejected, suggestion.key] }
    this.props.store.keepLearned(this.learned)
    if (this.current === suggestion.key) this.current = null
    if (this.lit === suggestion.key) this.lit = null
    this.scheduleSuggestions()
  }

  /** An answer, learned: one step of the confidence model towards it (§27.6). */
  private answer(suggestion: Suggestion, accepted: boolean): void {
    const weights = learn(this.learned.weights ?? INITIAL_WEIGHTS, suggestion.features, accepted)
    this.learned = { ...this.learned, weights, answers: this.learned.answers + 1 }
    this.props.store.keepLearned(this.learned)
  }

  /** A suggestion turned down, offered again. */
  private restore(key: string): void {
    this.learned = { ...this.learned, rejected: this.learned.rejected.filter((held) => held !== key) }
    this.props.store.keepLearned(this.learned)
    this.scheduleSuggestions()
  }

  /** Everything the answers taught, forgotten: the initial weights, nothing turned down. */
  private forget(): void {
    this.learned = { weights: null, answers: 0, rejected: [] }
    this.props.store.keepLearned(this.learned)
    this.scheduleSuggestions()
  }

  /**
   * Auto mode's run (§27.6): the best suggestion at the threshold or above,
   * applied as a step marked `auto`, the rest counted again, until none is left
   * above it.
   */
  private async runAuto(): Promise<void> {
    if (this.autoRunning) return
    this.autoRunning = true
    try {
      for (let k = 0; k < AUTO_MOST; k++) {
        const next = this.open().find((suggestion) => suggestion.confidence >= AUTO_THRESHOLD)
        if (next === undefined) break
        const before = this.props.store.applied
        this.accept(next, 'auto')
        window.clearTimeout(this.suggesting)
        this.suggesting = 0
        if (this.props.store.applied === before) break
        await this.recount()
        if (this.closed) return
      }
    } finally {
      this.autoRunning = false
    }
    this.paintSide()
    this.schedule()
  }

  private setMode(mode: Mode): void {
    if (mode !== 'manual' && this.suggested === null) return
    this.mode = mode
    this.stopPreview()
    this.current = mode === 'review' ? (this.open()[0]?.key ?? null) : null
    const current = this.byKey(this.current)
    if (current !== null) this.frameSuggestion(current)
    this.paintSide()
    this.schedule()
  }

  /** Review's next suggestion, or the one before. */
  private moveCurrent(delta: 1 | -1): void {
    const open = this.open()
    if (open.length === 0) return
    const at = open.findIndex((suggestion) => suggestion.key === this.current)
    const next = open[(Math.max(0, at) + delta + open.length) % open.length]
    this.current = next.key
    this.frameSuggestion(next)
    this.paintSide()
  }

  /** Space held in review: the map, its bars and its lanes, as they would be with the suggestion taken. */
  private startPreview(): void {
    const current = this.byKey(this.current)
    const layout = this.layout
    if (current === null || layout === null || this.drag !== null) return
    this.previewing = true
    this.preview = { grid: LensGrid.of(EditedAssembly.of(this.props.store.tentative(current.step)), layout), units: null }
    this.pictureDirty = true
    this.paintReview()
    this.schedule()
  }

  private stopPreview(): void {
    if (!this.previewing) return
    this.previewing = false
    this.preview = null
    this.pictureDirty = true
    this.paintReview()
    this.schedule()
  }

  /** The rail, painted again only when something it shows has changed. */
  private paintRail(marks: readonly MarkedSuggestion[], toY: (unit: number) => number, ink: StageInk): void {
    const [y0, y1] = this.sy.domain
    const signature = `${y0.toFixed(3)}:${y1.toFixed(3)}:${this.lit}:${this.current}:${marks.map((m) => m.suggestion.key).join('|')}`
    if (signature === this.railSignature) return
    this.railSignature = signature
    const items: RailItem[] = marks.map(({ suggestion, number }) => ({
      key: suggestion.key,
      number,
      text: `${KIND_WORD[suggestion.kind]} ${percent(suggestion.confidence)}`,
      title: suggestion.words,
      extent: suggestion.extent,
      lit: suggestion.key === this.lit,
      current: suggestion.key === this.current,
    }))
    this.rail.paint(items, toY, ink)
  }

  /** The line under the toolbar that says where review is, and what its keys do. */
  private paintReview(): void {
    const bar = this.reviewBar
    const current = this.byKey(this.current)
    if (this.mode !== 'review') {
      bar.classList.add('hidden')
      bar.replaceChildren()
      return
    }
    bar.classList.remove('hidden')
    const open = this.open()
    if (current === null) {
      bar.replaceChildren(el('span', { class: 'edit-review-words', text: open.length === 0 ? 'review · nothing left to answer' : 'review' }))
      return
    }
    const key = (text: string): HTMLElement => el('kbd', { class: 'kbd', text })
    bar.replaceChildren(
      el('span', { class: 'edit-review-where', text: `${open.findIndex((one) => one.key === current.key) + 1} of ${open.length}` }),
      el('span', { class: 'edit-review-words', text: `${current.words} · ${percent(current.confidence)}` }),
      el(
        'span',
        { class: 'edit-review-keys' },
        this.previewing ? el('span', { class: 'edit-review-state', text: 'as it would be' }) : '',
        key('Y'),
        ' take it ',
        key('N'),
        ' turn it down ',
        key('←'),
        key('→'),
        ' the others ',
        key('space'),
        ' held: as it would be',
        adjustableEnds(current).length > 0 ? ' · drag its ends to adjust it' : '',
      ),
    )
  }

  /** The card of suggestions: the list, best first, each with its answer. */
  private paintSuggestions(): void {
    const card = this.suggestionsCard
    const open = this.open()
    const weighing = this.suggesting !== 0 || this.recountRequest !== null || this.autoRunning
    const head = el('h3', {
      class: 'edit-card-head',
      text:
        this.suggested === null
          ? `suggestions${weighing ? ' · weighing…' : ''}`
          : `suggestions · ${open.length}${weighing ? ' · weighing…' : ''}`,
    })
    if (!this.weighs() || this.suggested === null) {
      card.replaceChildren(
        head,
        el('p', {
          class: 'edit-empty',
          text:
            this.picture === null
              ? 'Weighed once the picture is read: the map’s own contact law, then every junction the reference makes, and every two ends that might meet.'
              : // The first count, where the data is kept, is on its way.
                this.weighs() && weighing
                ? 'Weighing the map’s own contact law, then every junction the reference makes, and every two ends that might meet…'
                : 'The map gave the method nothing to weigh.',
        }),
      )
      return
    }
    const children: HTMLElement[] = [head]
    if (this.mode === 'auto') {
      const ready = open.filter((suggestion) => suggestion.confidence >= AUTO_THRESHOLD).length
      const run = this.act(
        ready === 0 ? `none at ${percent(AUTO_THRESHOLD)} or more` : `apply ${ready} at ${percent(AUTO_THRESHOLD)} or more`,
        'play',
        'Apply them best first, counting again after each: every one a step marked auto, to undo like any other',
        () => void this.runAuto(),
      )
      run.disabled = ready === 0 || this.autoRunning
      children.push(el('div', { class: 'edit-acts' }, run))
    }
    if (open.length === 0) {
      children.push(
        el('p', {
          class: 'edit-empty',
          text:
            this.declined().length > 0
              ? 'Nothing left to answer: what was turned down is below, to offer again. Drag along the diagonal to edit by hand.'
              : 'Nothing to suggest: every junction the reference makes is one the map supports, and no two ends it leaves apart meet. Drag along the diagonal to edit by hand.',
        }),
      )
    } else {
      const list = el('ol', { class: 'edit-suggestions' })
      open.forEach((suggestion, i) => list.append(this.suggestionRow(suggestion, i + 1)))
      children.push(list)
    }
    const declined = this.declined()
    if (declined.length > 0) {
      const details = el('details', { class: 'edit-declined' })
      details.append(el('summary', { text: `turned down · ${declined.length}` }))
      const list = el('ul', { class: 'edit-declined-list' })
      for (const suggestion of declined) {
        const restore = el('button', {
          class: 'btn btn-icon',
          title: 'Offer it again',
          attrs: { type: 'button', 'aria-label': `Offer ${suggestion.words} again` },
          on: { click: () => this.restore(suggestion.key) },
        })
        restore.append(icon('undo-2', { size: 13 }))
        list.append(el('li', {}, el('span', { class: 'edit-declined-words', text: suggestion.words }), restore))
      }
      details.append(list)
      children.push(details)
    }
    if (this.learned.answers > 0) {
      children.push(
        el(
          'p',
          { class: 'edit-note' },
          `ranked by what ${this.learned.answers} ${this.learned.answers === 1 ? 'answer' : 'answers'} taught it · `,
          el('button', { class: 'btn-link', text: 'forget', attrs: { type: 'button' }, title: 'Back to the initial weights, with nothing turned down', on: { click: () => this.forget() } }),
        ),
      )
    }
    card.replaceChildren(...children)
  }

  private suggestionRow(suggestion: Suggestion, number: number): HTMLElement {
    const lit = suggestion.key === this.lit
    const current = suggestion.key === this.current
    const row = el('li', {
      class: `edit-suggestion${lit ? ' is-lit' : ''}${current ? ' is-current' : ''}`,
      attrs: { 'data-key': suggestion.key },
      on: { pointerenter: () => this.setLit(suggestion.key), pointerleave: () => this.setLit(null) },
    })
    const main = el('button', {
      class: 'edit-suggestion-main',
      title: 'Frame it on the map',
      attrs: { type: 'button' },
      on: { click: () => this.pick(suggestion.key), focus: () => this.setLit(suggestion.key) },
    })
    const kindIcon = { split: 'split', turn: 'flip-horizontal', move: 'move', join: 'merge' } as const
    main.append(
      el('span', { class: 'edit-suggestion-n', text: String(number) }),
      icon(kindIcon[suggestion.kind], { size: 14 }),
      el('span', { class: 'edit-suggestion-words', text: suggestion.words }),
      el('span', { class: 'edit-suggestion-confidence', text: percent(suggestion.confidence) }),
    )
    // `adjusted` is the way back as well as the word (§27.6): its ends put
    // back where the method found them, from the chip that says they moved.
    const chipOf = (chip: string): HTMLElement => {
      if (chip !== 'adjusted' || !this.adjustments.has(suggestion.key)) return el('span', { class: 'edit-chip', text: chip })
      const back = el('button', {
        class: 'edit-chip edit-chip-button',
        title: 'Put its ends back where the method found them',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.adjustments.delete(suggestion.key)
            this.railSignature = ''
            this.paintSide()
            this.schedule()
          },
        },
      })
      back.append(el('span', { text: 'adjusted' }), icon('undo-2', { size: 11 }))
      return back
    }
    const chips = el('div', { class: 'edit-suggestion-chips' }, ...suggestion.evidence.map(chipOf))
    const take = el('button', {
      class: 'btn edit-suggestion-act',
      title: 'Take it: its step, made (Y)',
      attrs: { type: 'button', 'aria-label': `Take ${suggestion.words}` },
      on: { click: () => this.accept(suggestion) },
    })
    take.append(icon('check', { size: 13 }), el('span', { text: 'take' }), el('kbd', { class: 'kbd', text: 'Y' }))
    const down = el('button', {
      class: 'btn edit-suggestion-act',
      title: 'Turn it down: gone from the map, and learned from (N)',
      attrs: { type: 'button', 'aria-label': `Turn down ${suggestion.words}` },
      on: { click: () => this.reject(suggestion) },
    })
    down.append(icon('x', { size: 13 }), el('span', { text: 'turn down' }), el('kbd', { class: 'kbd', text: 'N' }))
    row.append(main, el('div', { class: 'edit-suggestion-foot' }, chips, el('div', { class: 'edit-suggestion-acts' }, take, down)))
    return row
  }

  private act(label: string, name: Parameters<typeof icon>[0], title: string, run: () => void, key?: string): HTMLButtonElement {
    const button = el('button', {
      class: 'btn edit-act',
      title: key === undefined ? title : `${title} (${key})`,
      attrs: { type: 'button' },
      on: { click: run },
    })
    button.append(icon(name, { size: 14 }), el('span', { text: label }))
    if (key !== undefined) button.append(el('kbd', { class: 'kbd', text: key }))
    return button
  }

  private paintSelection(): void {
    const card = this.selectionCard
    const head = el('h3', { class: 'edit-card-head', text: 'selection' })
    const selection = this.selection
    if (selection === null) {
      card.replaceChildren(
        head,
        el('p', {
          class: 'edit-empty',
          text: 'Drag along the diagonal to select a stretch, or press a piece, on the map or on a bar; drag off it to box two stretches, or press a corner for the stretch between its two ends.',
        }),
      )
      return
    }
    if (selection.kind === 'stretch') {
      const stretch = selection.stretch
      const pieces = this.props.store.assembly.piecesIn(stretch.sequence, stretch.from, stretch.to).length
      card.replaceChildren(
        head,
        el('div', { class: 'edit-locus', text: formatLocus({ contig: stretch.sequence, start: stretch.from, end: stretch.to }) }),
        el('div', {
          class: 'edit-note',
          text: `${fmt.bp(stretch.to - stretch.from)} · ${pieces} ${pieces === 1 ? 'piece' : 'pieces'}`,
        }),
        el(
          'div',
          { class: 'edit-acts' },
          this.act('turn', 'flip-horizontal', 'Turn the stretch round', () => this.turn(stretch), 'I'),
          this.act('copy', 'copy', 'Copy the stretch in after itself', () => this.copy(stretch)),
          this.act('own sequence', 'split', 'Make the stretch a sequence of its own', () => this.splitOut(stretch), 'S'),
          this.act('set aside', 'trash-2', 'Take the stretch out of the assembly, with a reason', () => {
            const rect = card.getBoundingClientRect()
            this.asideMenu(stretch, rect.left + 16, rect.bottom - 8)
          }, 'delete'),
        ),
        el('p', {
          class: 'edit-hint',
          text: 'Drag its square, or its piece on a bar, to move it: ⌥ copies it, I turns it on the way, and a whole sequence dropped on another’s end joins the two. A double click on a bar turns a piece.',
        }),
      )
      return
    }
    const { rows, cols } = selection
    const same = rows.sequence === cols.sequence && (rows.to <= cols.from || cols.to <= rows.from)
    const rowText = formatLocus({ contig: rows.sequence, start: rows.from, end: rows.to })
    const colText = formatLocus({ contig: cols.sequence, start: cols.from, end: cols.to })
    const swap = this.act('swap them', 'arrow-left-right', 'Each stretch takes the other’s place', () => this.swap(rows, cols))
    swap.disabled = !same
    if (!same) swap.title = 'Two stretches of one sequence that do not overlap swap places'
    card.replaceChildren(
      head,
      el('div', { class: 'edit-box-row' }, el('span', { class: 'edit-box-key', text: 'rows' }), el('span', { class: 'edit-locus', text: rowText })),
      el('div', { class: 'edit-box-row' }, el('span', { class: 'edit-box-key', text: 'columns' }), el('span', { class: 'edit-locus', text: colText })),
      el(
        'div',
        { class: 'edit-acts' },
        this.act('rows before columns', 'move', 'Move the rows’ stretch to just before the columns’', () => {
          this.step({ op: 'move', sequence: rows.sequence, from: rows.from, to: rows.to, into: cols.sequence, at: rows.sequence === cols.sequence && cols.from > rows.to ? cols.from - (rows.to - rows.from) : cols.from, strand: 1 })
        }),
        this.act('columns after rows', 'move', 'Move the columns’ stretch to just after the rows’', () => {
          this.step({ op: 'move', sequence: cols.sequence, from: cols.from, to: cols.to, into: rows.sequence, at: rows.sequence === cols.sequence && rows.to > cols.to ? rows.to - (cols.to - cols.from) : rows.to, strand: 1 })
        }),
        swap,
        this.act('turn rows', 'flip-vertical', 'Turn the rows’ stretch round', () => this.turn(rows)),
        this.act('turn columns', 'flip-horizontal', 'Turn the columns’ stretch round', () => this.turn(cols)),
      ),
    )
  }

  private paintHistory(): void {
    const store = this.props.store
    const { history, cursor } = store.edit
    const list = el('ol', { class: 'edit-history' })
    const row = (count: number, text: string): HTMLElement => {
      const item = el('li', {
        class: `edit-history-row${count === cursor ? ' is-current' : ''}${count > cursor ? ' is-undone' : ''}`,
      })
      const button = el('button', {
        class: 'edit-history-button',
        attrs: { type: 'button', 'aria-current': count === cursor ? 'step' : 'false' },
        title: count === cursor ? 'Where the edit stands' : count > cursor ? 'Redo up to here' : 'Go back to here',
        on: { click: () => store.goTo(count) },
      })
      button.append(el('span', { class: 'edit-history-n', text: count === 0 ? '·' : String(count) }), el('span', { text }))
      item.append(button)
      return item
    }
    list.append(row(0, 'the file as it is'))
    history.forEach((entry, i) => {
      const item = row(i + 1, stepText(entry.step))
      // A step a suggestion made says so, and what it rested on (§27.2).
      if (entry.by !== 'reader') {
        const by = el('span', { class: 'edit-history-by', text: entry.by === 'auto' ? 'auto' : 'suggested' })
        if (entry.suggestion !== undefined) by.title = entry.suggestion
        item.querySelector('.edit-history-button')?.append(by)
      }
      list.append(item)
    })
    const refusal = store.refusal === null ? null : el('p', { class: 'edit-note', text: store.refusal })
    this.historyCard.replaceChildren(
      el('h3', { class: 'edit-card-head', text: `history${history.length > 0 ? ` · ${cursor} of ${history.length}` : ''}` }),
      ...(refusal === null ? [] : [refusal]),
      list,
    )
  }

  private paintSequences(): void {
    const assembly = this.props.store.assembly
    const list = el('ul', { class: 'edit-sequences' })
    for (const sequence of assembly.sequences) {
      const length = assembly.lengthOf(sequence.name) ?? 0
      const pieces = sequence.parts.filter((part) => !('gap' in part)).length
      const selected =
        this.selection?.kind === 'stretch' &&
        this.selection.stretch.sequence === sequence.name &&
        this.selection.stretch.from === 0 &&
        this.selection.stretch.to === length
      const button = el('button', {
        class: `edit-sequence${selected ? ' is-selected' : ''}`,
        attrs: { type: 'button' },
        title: 'Select the whole sequence, and frame it',
        on: {
          click: () => {
            this.selection = { kind: 'stretch', stretch: { sequence: sequence.name, from: 0, to: length } }
            const grid = this.grid
            const units = grid === null ? null : stretchUnits(grid, this.selection.stretch)
            if (units !== null) this.frameUnits(units[0], units[1])
            this.paintSide()
            this.schedule()
          },
        },
      })
      const units = this.grid?.sequence(sequence.name)
      if (units !== undefined && units !== null) button.dataset.cells = `${units.from} ${units.to}`
      const circle = this.circularOf(sequence.name)
      button.append(
        el('span', { class: 'edit-sequence-name', text: sequence.name, ...(circle ? { title: 'circular' } : {}) }),
        el('span', { class: 'edit-sequence-length', text: fmt.bp(length) }),
        el('span', { class: 'edit-sequence-pieces', text: `${circle ? '○ ' : ''}${pieces === 1 ? '' : `${pieces} pieces`}` }),
      )
      if (this.renaming === sequence.name) {
        list.append(el('li', { class: 'edit-sequence-row' }, this.renameBox(sequence.name)))
        continue
      }
      // A name of its own (§27.3): the pencil, or a double click on the row.
      button.addEventListener('dblclick', (event) => {
        event.preventDefault()
        this.startRename(sequence.name)
      })
      const pencil = el('button', {
        class: 'btn-icon edit-sequence-rename',
        title: `Rename ${sequence.name}`,
        attrs: { type: 'button', 'aria-label': `Rename ${sequence.name}` },
        on: { click: () => this.startRename(sequence.name) },
      })
      pencil.append(icon('pencil', { size: 12 }))
      list.append(el('li', { class: 'edit-sequence-row' }, button, pencil))
    }
    const aside =
      assembly.aside.length === 0
        ? null
        : el(
            'div',
            { class: 'edit-aside' },
            el('h4', { class: 'edit-card-sub', text: `set aside · ${assembly.aside.length}` }),
            el(
              'ul',
              { class: 'edit-aside-list' },
              ...assembly.aside.map((item) =>
                el(
                  'li',
                  {},
                  el('span', { text: formatLocus({ contig: item.piece.sequence, start: item.piece.start, end: item.piece.end }) }),
                  // Sent to another genome of the metagenome, which (§27.10).
                  el('span', {
                    class: 'edit-aside-why',
                    text: item.genome === undefined ? item.why : `→ ${item.genome === '__unbinned__' ? 'no genome' : item.genome}`,
                    title: item.genome === undefined ? '' : `A contig of ${item.genome === '__unbinned__' ? 'no genome' : item.genome} now, by its contacts`,
                  }),
                ),
              ),
            ),
          )
    // Longest first, the order an assembly is conventionally written in: one
    // step, undone as any is (§27.3).
    const byLength = [...assembly.sequences].sort((a, b) => (assembly.lengthOf(b.name) ?? 0) - (assembly.lengthOf(a.name) ?? 0)).map((sequence) => sequence.name)
    const sorted = byLength.every((name, i) => assembly.sequences[i].name === name)
    const sort = el('button', {
      class: 'btn btn-quiet edit-card-act',
      title: sorted ? 'They are longest first already' : 'Put the sequences longest first — one step, to undo like any other',
      attrs: { type: 'button' },
      on: { click: () => this.step({ op: 'reorder', names: byLength }) },
    })
    sort.append(el('span', { text: 'longest first' }))
    sort.disabled = sorted
    this.sequencesCard.replaceChildren(
      el('div', { class: 'edit-card-headrow' }, el('h3', { class: 'edit-card-head', text: `sequences · ${assembly.sequences.length}` }), sort),
      ...(this.sequencesNote === '' ? [] : [el('p', { class: 'edit-note edit-sequences-note', text: this.sequencesNote })]),
      list,
      ...(aside === null ? [] : [aside]),
    )
  }

  private startRename(name: string): void {
    this.renaming = name
    this.sequencesNote = ''
    this.paintSequences()
    this.sequencesCard.querySelector<HTMLInputElement>('.edit-rename-input')?.select()
  }

  /**
   * The box a sequence is renamed in: Enter makes it a step, Escape or a click
   * away leaves the name as it was. A name is one word, and one no other
   * sequence of the edit has — a FASTA header and an AGP line are split on
   * spaces, and two sequences of one name are one too many for either.
   */
  private renameBox(name: string): HTMLElement {
    const input = el('input', { class: 'input edit-rename-input', attrs: { type: 'text', value: name, 'aria-label': `New name for ${name}`, spellcheck: 'false' } }) as HTMLInputElement
    const done = (commit: boolean): void => {
      if (this.renaming !== name) return
      this.renaming = null
      const wanted = input.value.trim()
      if (commit && wanted !== name) {
        const taken = this.props.store.assembly.sequences.some((sequence) => sequence.name === wanted)
        const theFiles = this.props.store.edit.original.names.includes(wanted)
        if (wanted === '' || /\s/.test(wanted)) this.sequencesNote = 'A name is one word: a FASTA header and an AGP line are split on spaces.'
        else if (taken) this.sequencesNote = `${wanted} is the name of another sequence already.`
        else if (theFiles) this.sequencesNote = `${wanted} is a name of the file’s own, for that sequence whole and no other.`
        else {
          this.sequencesNote = ''
          this.step({ op: 'rename', sequence: name, name: wanted })
          return
        }
      }
      this.paintSequences()
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        done(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        done(false)
      }
    })
    input.addEventListener('blur', () => done(false))
    return input
  }

  /**
   * On one genome of a metagenome (§27.10): what its contacts say about where
   * its contigs belong — how much of their contacts stay with the genome, the
   * contigs that meet another genome more, each with a way to send it there,
   * and the contigs of other genomes that meet this one most, each with a way
   * to bring it in.
   */
  private paintGenome(): void {
    const genome = this.props.store.edit.original.genome
    if (genome === undefined) return
    const links = this.links
    const head = el('h3', { class: 'edit-card-head', text: `genome · ${genome}` })
    if (this.linksRequest !== null) {
      this.genomeCard.replaceChildren(
        head,
        el(
          'p',
          { class: 'edit-note' },
          `Reading every contact for where the contigs belong… ${this.linksDone === null ? '' : `${Math.round(this.linksDone * 100)}%`} `,
          el('button', { class: 'btn-link', text: 'cancel', attrs: { type: 'button' }, on: { click: () => this.linksRequest?.cancel() } }),
        ),
      )
      return
    }
    if (links === null) {
      this.genomeCard.replaceChildren(
        head,
        el('p', { class: 'edit-note', text: 'Which of its contigs meet another genome more, and which of other genomes’ meet this one: one pass over every contact of the file.' }),
        ...(this.props.genomeLinks === undefined
          ? []
          : [el('button', { class: 'btn', text: 'read every contact', attrs: { type: 'button' }, on: { click: () => this.readLinks() } })]),
      )
      return
    }
    const assembly = this.props.store.assembly
    const placed = new Set(assembly.sequences.flatMap((sequence) => sequence.parts.flatMap((part) => (isGap(part) ? [] : [part.sequence]))))
    const inside = links.inside.filter((row) => placed.has(row.contig))
    const own = inside.reduce((sum, row) => sum + row.own, 0)
    const total = inside.reduce((sum, row) => sum + row.total, 0)
    const label = (name: string): string => (name === '__unbinned__' ? 'no genome' : name)
    const share = (part: number, whole: number): string => `${whole > 0 ? Math.round((100 * part) / whole) : 0}%`
    // A contig that meets another genome more than this one, with enough contacts to say.
    const strays = inside
      .flatMap((row) => {
        const other = row.partners.find((partner) => partner.genome !== genome)
        return other !== undefined && other.contacts > row.own && row.total >= LEAST_LINKS ? [{ row, other }] : []
      })
      .sort((a, b) => b.other.contacts / b.row.total - a.other.contacts / a.row.total)
      .slice(0, 8)
    const candidates = links.outside
      .filter((row) => !placed.has(row.contig) && row.contacts >= LEAST_LINKS && row.contacts / row.total >= BELONGS)
      .slice(0, 8)
    const stale = this.linksOf !== this.linksKey()
    this.genomeCard.replaceChildren(
      head,
      el('p', {
        class: 'edit-note',
        text: `${share(own, total)} of its contigs’ contacts with other contigs are with its own${stale ? ' — read before the last contig came in' : ''}.`,
      }),
      el('h4', { class: 'edit-genome-sub', text: strays.length === 0 ? 'No contig of it meets another genome more' : 'Meet another genome more' }),
      ...(strays.length === 0
        ? []
        : [
            el(
              'ul',
              { class: 'edit-genome-list' },
              ...strays.map(({ row, other }) =>
                el(
                  'li',
                  { class: 'edit-genome-row' },
                  el('span', { class: 'edit-genome-name', text: row.contig, title: row.contig }),
                  el('span', { class: 'edit-genome-share', text: `${share(row.own, row.total)} here · ${share(other.contacts, row.total)} ${label(other.genome)}` }),
                  el('button', {
                    class: 'btn edit-genome-act',
                    text: `send to ${label(other.genome)}`,
                    title: `Take ${row.contig} out of ${genome}, as a contig of ${label(other.genome)}: a step to undo like any other`,
                    attrs: { type: 'button' },
                    on: { click: () => this.send(row.contig, other.genome) },
                  }),
                ),
              ),
            ),
          ]),
      el('h4', { class: 'edit-genome-sub', text: candidates.length === 0 ? 'No contig elsewhere meets this genome most' : 'Meet this genome most' }),
      ...(candidates.length === 0
        ? []
        : [
            el(
              'ul',
              { class: 'edit-genome-list' },
              ...candidates.map((row) =>
                el(
                  'li',
                  { class: 'edit-genome-row' },
                  el('span', { class: 'edit-genome-name', text: row.contig, title: `${row.contig} · ${fmt.bp(row.length)} · of ${label(row.genome)}` }),
                  el('span', { class: 'edit-genome-share', text: `${label(row.genome)} · ${share(row.contacts, row.total)} of its contacts here` }),
                  el('button', {
                    class: 'btn edit-genome-act',
                    text: 'bring in',
                    title: `Bring ${row.contig} into ${genome}, whole, as a contig of its own: a step to undo like any other`,
                    attrs: { type: 'button' },
                    on: { click: () => this.props.store.bring({ name: row.contig, length: row.length, genome: row.genome }) },
                  }),
                ),
              ),
            ),
          ]),
      ...(stale && this.props.genomeLinks !== undefined
        ? [el('button', { class: 'btn-link', text: 'read again', attrs: { type: 'button' }, on: { click: () => this.readLinks() } })]
        : []),
    )
  }

  /** Send a contig of this genome to another (§27.10): every stretch of it the edit places, set aside as that genome's. */
  private send(contig: string, genome: string): void {
    const store = this.props.store
    for (const landing of [...store.assembly.landings(contig)].sort((a, b) => b.offset - a.offset)) {
      const length = landing.piece.end - landing.piece.start
      store.apply({ op: 'aside', sequence: landing.sequence, from: landing.offset, to: landing.offset + length, why: 'contaminant', genome })
    }
  }

  /** What the picture is of: the whole map, or one genome's contigs of a metagenome (§27.10). */
  private pictureOf(): string {
    const genome = this.props.store.edit.original.genome
    return genome === undefined ? 'The whole map' : `${genome}’s contigs alone, the rest of the metagenome left out,`
  }

  private paintPicture(): void {
    const picture = this.picture
    const evidence = this.evidence
    let sequence: string | null = null
    if (this.readingEvidence) sequence = 'Reading the sequence for its telomeres and gaps…'
    else if (evidence !== null) {
      const facts = [...evidence.facts.values()]
      const ends = facts.reduce((sum, fact) => sum + (fact.start === null ? 0 : 1) + (fact.end === null ? 0 : 1), 0)
      const gaps = facts.reduce((sum, fact) => sum + fact.gaps.length, 0)
      sequence =
        `From ${evidence.from}: telomeric repeats at ${ends.toLocaleString('en-US')} of ${(2 * facts.length).toLocaleString('en-US')} ends` +
        (evidence.gapsRead ? `, ${gaps.toLocaleString('en-US')} gap${gaps === 1 ? '' : 's'} of N` : '') +
        ' — a join that would bury a telomere counts against itself, and a break beside a gap is placed at it.'
    }
    this.pictureCard.replaceChildren(
      el('h3', { class: 'edit-card-head', text: 'picture' }),
      el('p', {
        class: 'edit-note',
        text:
          picture === null
            ? `${this.pictureOf()}, read once for the stage.`
            : `${this.pictureOf()} at ${fmt.bp(picture.binsize)} a cell, ${picture.n.toLocaleString('en-US')} cells a side, ${picture.balanced ? 'balanced' : 'raw counts'}; pieces move in whole cells, so a junction inside a cell is placed to the nearest edge.`,
      }),
      this.cellsChoice(),
      // Zoomed past a cell: the window read again, finer (§27.9).
      ...(this.windowRead === null || this.windowRead.key !== this.windowKey()
        ? []
        : [el('p', { class: 'edit-note edit-window-note', text: `Closer than a cell, the map on screen is read again at ${fmt.bp(this.windowRead.read.binsize)} a bin, through the edit.` })]),
      ...(sequence === null ? [] : [el('p', { class: 'edit-note edit-evidence-note', text: sequence })]),
    )
  }

  // -------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------

  private teardown(): void {
    if (this.closed) return
    this.closed = true
    this.request?.cancel()
    this.request = null
    this.linksRequest?.cancel()
    this.linksRequest = null
    this.recountRequest?.cancel()
    this.recountRequest = null
    this.windowRequest?.cancel()
    this.windowRequest = null
    window.clearTimeout(this.windowTimer)
    window.clearTimeout(this.suggesting)
    if (this.frame !== 0) cancelAnimationFrame(this.frame)
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('blur', this.onBlur)
    this.observer?.disconnect()
    this.stopStore()
    this.lanes?.destroy()
    closeMenu()
    // The picture is the stage's alone (§27.9): it goes with it.
    this.picture = null
    this.image = null
    this.props.onClose()
  }
}
