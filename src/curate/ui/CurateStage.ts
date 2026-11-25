/**
 * The curation stage (SPECS §33.3): the whole window, given to one task — the
 * metagenome's binning, curated by hand and by suggestion.
 *
 * Three columns: the **genome list** on the left, which never leaves the
 * screen, so anything held can be dropped on it; the **pictures** in the middle
 * — one large and the other two small beside it, lit together, the large one
 * following the review — under a toolbar whose readout says what is under the
 * pointer, or the curation's running tally; and the **inspector** on the
 * right, its cards in the order the mode wants them.
 *
 * The stage owns what joins the parts: the controller (`curate/model.ts`), the
 * keys (`ui/stageKeys.ts`), the one drag in flight, the readout, the theme, the
 * contacts' read with its bar and cancel, and the review's band and price. The
 * parts — the pictures, the cards, the chooser — are built from
 * {@link CurateParts}, so a test can give it stand-ins.
 */

import type { StageInk } from '../../edit/draw'
import { readInk } from '../../edit/draw'
import { POOL_COLOUR, POOL_RGBA, genomeColour, slotApart, slotOf, type GenomeColour } from '../colours'
import { CurateModel, displayPercent, type Cancellable, type CurateChange, type CurateClient } from '../model'
import { counted } from '../changes'
import { contigShortName, sharedPrefix, shortName } from '../names'
import { questionNumber, type Question } from '../questions'
import { newlyDuplicated, priceOf, priceVerdict, redundancyText, type PriceRow } from '../price'
import type { Quality } from '../quality'
import type { Suggestion } from '../suggest'
import { AUTO_THRESHOLD, LIKELY, OFFER_FLOOR } from '../method'
import { watchTheme } from '../../ui/analysisPlots'
import { keyBadge, withKey } from '../../ui/commands'
import { el } from '../../ui/dom'
import { iconButton } from '../../ui/icons'
import type { Modal } from '../../ui/Modal'
import { stageDialog } from '../../ui/StageDialog'
import { stageKeys } from '../../ui/stageKeys'
import { recall, remember } from '../../state/UiMemory'
import type { CurationStore } from '../../state/curation'
import { fmt } from '../../units'
import type { CurationBaseResult, CurationFocusResult, CurationNetworkResult, CurationStateResult } from '../../worker/curateProtocol'
import type { CurateContext, CurateData, CurateDragged, CurateDropTarget, CurateFrame, CuratePane } from './context'
import { qualityShift, swatch, type Shift } from './cards/card'
import { chooseStep } from './Chooser'
import { GenomeList } from './GenomeList'

/** A card of the inspector. */
export interface CurateCard {
  readonly element: HTMLElement
  update(change: CurateChange): void
  dispose?(): void
}

/** What a chooser leaves open: the stage closes it with Escape. */
export interface CurateChooser {
  close(): void
  /** Whether it is still open: a chooser closes itself on a press outside it, or a resize. */
  readonly open?: boolean
}

/** The parts the stage is built from. */
export interface CurateParts {
  contacts(ctx: CurateContext): CuratePane & { closeUp?(): void; back?(): void }
  hosts(ctx: CurateContext): CuratePane
  scatter(ctx: CurateContext): CuratePane
  selection(ctx: CurateContext, hooks: { rename(id: string): void; closeUp(): void; choose(kind: 'move' | 'merge' | 'link', anchor?: HTMLElement): void }): CurateCard
  suggestions(ctx: CurateContext, hooks: { frame(s: Suggestion): void }): CurateCard
  history(ctx: CurateContext, options: { store: CurationStore }): CurateCard
  exporting(ctx: CurateContext, options: { stem: string; store: CurationStore }): CurateCard
  about(ctx: CurateContext, options: { network: () => CurationNetworkResult | null }): CurateCard
  chooser(ctx: CurateContext, kind: 'move' | 'merge' | 'link', anchor: HTMLElement | { x: number; y: number }, onChoose: (target: CurateDropTarget) => void): CurateChooser
}

/** The reader's requests the stage makes. */
export interface CurateRequests {
  network(onProgress: (done: number, total: number, note?: string) => void): Cancellable<CurationNetworkResult>
  state: CurateClient['state']
  focus(contigs: Int32Array): Cancellable<CurationFocusResult>
}

export interface CurateStageProps {
  /** The map's label. */
  title: string
  /** The stem the exports are named from. */
  stem: string
  store: CurationStore
  base: CurationBaseResult
  requests: CurateRequests
  parts: CurateParts
  memoryKey(): string
  /**
   * A press before the contacts' read, where it would be long — a remote file
   * past the size a stage reads without asking: the price it says. `null`
   * reads at once.
   */
  gate: { pixels: number; bytes: number | null } | null
  onClose(): void
  /** How long after a step the count is asked, in ms; tests ask at once. */
  debounce?: number
}

/** The three pictures, in the order their keys say them. */
const PANES = ['contacts', 'hosts', 'scatter'] as const
type PaneName = (typeof PANES)[number]
const PANE_WORD: Record<PaneName, string> = { contacts: 'contacts', hosts: 'hosts', scatter: 'GC × coverage' }
/** A picture's tab: one short word, so the readout beside the tabs keeps its room. */
const PANE_TAB: Record<PaneName, string> = { contacts: 'contacts', hosts: 'hosts', scatter: 'scatter' }
const PANE_KEY: Record<PaneName, string> = { contacts: '1', hosts: '2', scatter: '3' }

/** What a mode button says while there is nothing to answer. */
/** Review's and auto's title while they are off: why, before the contacts are read and after. */
const NOTHING_TO_ANSWER = 'Nothing to answer: the suggestions come once the contacts are read.'
const NOTHING_ON_OFFER = `Nothing on offer: every suggestion is answered, turned down or under ${Math.round(OFFER_FLOOR * 100)}%.`

/**
 * Narrower than this, the two small pictures go under the large one, side by
 * side; narrower than {@link TIGHT}, the large picture is alone and the tabs
 * choose it. A 1600-px window keeps the three side by side, a laptop's the strip.
 */
const NARROW = 720
const TIGHT = 440
/** A held drag rests this long on a target before the pictures draw it made. */
const DROP_PREVIEW_MS = 300
/** The MAGs the band's price prints, before it counts the rest; and the genomes a sum names, as the cards' (`cards/card.ts`). */
const BAND_PRICED = 3
const BAND_SUMMANDS = 3
/** The band's price, whole, without its sums, then without its words: the first its line holds. */
const BAND_FORMS = ['whole', 'unsummed', 'bare'] as const
type BandForm = (typeof BAND_FORMS)[number]

export class CurateStage {
  private readonly modal: Modal
  private readonly model: CurateModel
  private readonly ctx: CurateContext
  private readonly root: HTMLElement
  private readonly centre: HTMLElement
  private readonly readout: HTMLElement
  private readonly band: HTMLElement
  private readonly status: HTMLElement
  private readonly paneArea: HTMLElement
  private readonly tabs: HTMLElement
  /** The toolbar's tools at its right: tidy, undo, redo, the keys, and the inspector's toggle. */
  private readonly tools: HTMLElement
  private readonly list: GenomeList
  private readonly panes: Record<PaneName, CuratePane & { closeUp?(): void; back?(): void }>
  private readonly cards: CurateCard[] = []
  private readonly modes: Record<'manual' | 'review' | 'auto', HTMLButtonElement>
  private readonly modeTitles: Record<'manual' | 'review' | 'auto', string>
  private readonly undoButton: HTMLButtonElement
  private readonly redoButton: HTMLButtonElement
  private readonly side: HTMLElement
  private readonly cardOf: Record<'selection' | 'suggestions' | 'history' | 'export' | 'about', CurateCard>
  private large: PaneName
  /** The large picture the reader chose, which the review's choice does not overwrite. */
  private chosen: PaneName
  private inkHeld: StageInk | null = null
  private readonly data: CurateData
  private network: Cancellable<CurationNetworkResult> | null = null
  /** The contacts' read, once done: what *about the map* says of it. */
  private networkSummary: CurationNetworkResult | null = null
  /** Where the contacts' read stands, on the stage's root for scripts (`data-contacts`). */
  private set networkState(state: 'gated' | 'reading' | 'read' | 'failed' | 'cancelled') {
    this.root.dataset.contacts = state
  }
  private dragging: CurateDragged | null = null
  private dragEnd: (() => void) | null = null
  private chooser: CurateChooser | null = null
  private space = false
  private pointer: { x: number; y: number } = { x: 0, y: 0 }
  private readonly frameListeners = new Set<(target: CurateFrame) => void>()
  private readonly prefixes: { mag: string; element: string } = { mag: '', element: '' }
  private prefixedFor: CurationStateResult | null = null
  private readonly offs: Array<() => void> = []
  private closed = false
  private sayHeld: string | null = null

  constructor(private readonly props: CurateStageProps) {
    const { store, base } = props
    this.data = {
      title: props.title,
      file: store.file,
      gc: base.gc,
      coverage: null,
      coverageLabel: 'Hi-C contacts per kb',
      markerSets: base.markerSets,
      background: null,
    }
    this.model = new CurateModel(store, { state: (curation, weights, declined) => props.requests.state(curation, weights, declined) }, props.debounce === undefined ? {} : { debounce: props.debounce })
    this.ctx = this.context()

    // The centre: toolbar, band, status, panes.
    this.readout = el('div', { class: 'curate-readout', attrs: { 'aria-live': 'polite' } })
    this.undoButton = iconButton('undo-2', withKey('Undo the last step', 'mod+z'), () => this.model.undo(), { class: 'btn btn-icon', size: 15 })
    this.redoButton = iconButton('redo-2', withKey('Redo it', 'mod+shift+z'), () => this.model.redo(), { class: 'btn btn-icon', size: 15 })
    this.tabs = el('div', { class: 'curate-tabs', attrs: { role: 'group', 'aria-label': 'The large picture' } })
    for (const name of PANES) {
      const tab = el('button', {
        class: 'btn btn-toggle curate-tab',
        attrs: { type: 'button', 'aria-pressed': 'false', 'data-pane-tab': name },
        title: withKey(`Show the ${PANE_WORD[name]} large`, PANE_KEY[name]),
        on: { click: () => this.choose(name) },
      })
      tab.append(el('span', { text: PANE_TAB[name] }), keyBadge(PANE_KEY[name], { class: 'kbd-inline' }))
      this.tabs.appendChild(tab)
    }
    // Bordered as its neighbours are: a word among icons is a control all the same.
    const tidy = el('button', {
      class: 'btn curate-tidy',
      text: 'tidy',
      title: 'Lay the genomes out again, the ones that meet densely side by side',
      attrs: { type: 'button' },
      on: { click: () => this.model.tidy() },
    })
    const keysButton = iconButton('keyboard', withKey('Keys on this stage', '?'), () => this.showKeys(), { class: 'btn btn-icon', size: 15 })
    this.tools = el('div', { class: 'curate-tools' }, tidy, this.undoButton, this.redoButton, keysButton)
    const toolbar = el('div', { class: 'curate-toolbar' }, this.tabs, this.tools)
    this.band = el('div', { class: 'curate-band hidden', attrs: { 'aria-live': 'polite' } })
    this.status = el('div', { class: 'curate-status hidden', attrs: { role: 'status' } })
    this.paneArea = el('div', { class: 'curate-panes' })
    // The readout on its own line under the toolbar, the centre's width wide.
    this.centre = el('div', { class: 'curate-centre' }, toolbar, this.readout, this.band, this.status, this.paneArea)

    // The list, and its grip.
    this.list = new GenomeList(this.ctx)
    const listColumn = el('div', { class: 'curate-list-column' }, this.list.element)
    const width = recall<number>(props.memoryKey(), 'curate:list')
    if (typeof width === 'number' && Number.isFinite(width)) listColumn.style.width = `${Math.max(220, Math.min(480, width))}px`
    const grip = el('div', { class: 'curate-list-grip', attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the genome list', tabindex: '0' } })
    this.wireGrip(grip, listColumn)
    this.root = el('div', { class: 'curate-stage', attrs: { 'data-stage': 'curate' } }, listColumn, grip, this.centre)

    // The pictures.
    this.panes = {
      contacts: props.parts.contacts(this.ctx),
      hosts: props.parts.hosts(this.ctx),
      scatter: props.parts.scatter(this.ctx),
    }
    const remembered = recall<string>(props.memoryKey(), 'curate:large')
    this.large = this.chosen = (PANES as readonly string[]).includes(remembered ?? '') ? (remembered as PaneName) : 'contacts'

    // The inspector.
    this.modeTitles = {
      manual: 'The suggestions are drawn and listed, and never apply themselves',
      review: 'Work through the suggestions, merges first: Y takes one, N turns it down, and every answer teaches the ranking',
      auto: `Take every suggestion at ${Math.round(AUTO_THRESHOLD * 100)}% or more in the queue’s order — merges first, then moves, recruits and links —, each a step to undo like any other`,
    }
    this.modes = {
      manual: this.modeButton('manual', this.modeTitles.manual),
      review: this.modeButton('review', this.modeTitles.review),
      auto: this.modeButton('auto', this.modeTitles.auto),
    }
    // What the three modes decide, in the words a newcomer reads it by: who
    // applies the suggestions — the reader, one question at a time, or auto.
    const modesCard = el(
      'section',
      { class: 'edit-card curate-modes-card' },
      el('h3', { class: 'edit-card-head', text: 'apply suggestions' }),
      el('div', { class: 'edit-modes', attrs: { role: 'group', 'aria-label': 'Apply suggestions' } }, this.modes.manual, this.modes.review, this.modes.auto),
    )
    this.cardOf = {
      selection: props.parts.selection(this.ctx, {
        rename: (id) => this.list.startRename(id),
        closeUp: () => this.closeUp(),
        choose: (kind, anchor) => this.openChooser(kind, anchor),
      }),
      suggestions: props.parts.suggestions(this.ctx, { frame: (s) => this.frameSuggestion(s) }),
      history: props.parts.history(this.ctx, { store }),
      export: props.parts.exporting(this.ctx, { stem: props.stem, store }),
      about: props.parts.about(this.ctx, { network: () => this.networkSummary }),
    }
    this.cards.push(...Object.values(this.cardOf))
    this.side = el('div', { class: 'curate-side-body' }, modesCard)
    this.arrangeSide()

    this.offs.push(this.model.subscribe((change) => this.changed(change)))
    this.offs.push(stageKeys(this.root, { down: (event) => this.key(event), up: (event) => this.keyUp(event), blur: () => this.letGo() }))
    this.offs.push(
      watchTheme(() => {
        this.inkHeld = null
        for (const pane of Object.values(this.panes)) pane.update('state')
        // The list's swatches too, or one genome wears two colours at once.
        this.list.update('state')
      }),
    )
    this.root.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY }
    })

    this.modal = stageDialog({
      title: `Curate the genomes · ${props.title}`,
      stage: this.root,
      side: this.side,
      variant: 'modal-curate',
      stageClass: 'curate-stage-body',
      sideClass: 'edit-side curate-side',
      memoryKey: props.memoryKey,
      scope: 'curate:side',
      onResize: () => this.resized(),
      onEscape: () => this.escape(),
      onClose: () => this.teardown(),
    })
    this.dockSideToggle()
    this.place()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.resized())
      observer.observe(this.centre)
      this.offs.push(() => observer.disconnect())
    }
    this.paintChrome()
    this.paintReadout()
    if (props.gate === null || base.networkHeld) this.readNetwork()
    else this.showGate(props.gate)
    requestAnimationFrame(() => this.list.focus())
  }

  /** Close the stage: the session is drawn through the curation as it stands. */
  close(): void {
    this.modal.close()
  }

  // -------------------------------------------------------------------------
  // The context the parts share.
  // -------------------------------------------------------------------------

  private context(): CurateContext {
    const stage = this
    const fileGenomes = this.props.store.file.genomes
    const fileIndex = new Map(fileGenomes.map((genome, g) => [genome.name, g]))
    const dark = (): boolean => {
      const theme = document.documentElement.getAttribute('data-theme')
      if (theme === 'dark') return true
      if (theme === 'light') return false
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    }
    const colours = new Map<string, GenomeColour>()
    /** The slot each genome is drawn with: a created one's, stepped apart from its neighbours'. */
    const slots = new Map<string, number>()
    let coloursDark: boolean | null = null
    /** A genome as drawn now — the preview's while one is — else as counted. */
    const drawn = (id: string): CurationStateResult['genomes'][number] | undefined =>
      stage.model.shown?.genomes.find((genome) => genome.id === id) ?? stage.model.answer?.genomes.find((genome) => genome.id === id)
    return {
      get model() {
        return stage.model
      },
      data: this.data,
      colourOf(id: string): GenomeColour {
        const isDark = dark()
        if (coloursDark !== isDark) {
          colours.clear()
          coloursDark = isDark
        }
        // By kind too: a genome retyped is drawn in its new kind's lightness —
        // the preview's kind while a retype is drawn.
        const kind = drawn(id)?.kind ?? fileGenomes[fileIndex.get(id) ?? -1]?.kind ?? 'mag'
        const key = `${kind}\t${id}`
        const held = colours.get(key)
        if (held !== undefined) return held
        let slot = slots.get(id) ?? slotOf(fileIndex.get(id) ?? -1, id, fileGenomes.length)
        // A genome a step made is laid beside the genome its contigs came from:
        // its hue stands apart from its neighbours' as they are drawn
        // (`colours.ts`), fixed once it has its place — a preview's new genome
        // has none yet, and is coloured for the moment only.
        let placed = true
        if (!fileIndex.has(id) && !slots.has(id)) {
          const order = stage.model.order
          const at = order.indexOf(id)
          placed = at >= 0
          const near = [order[at - 1], order[at + 1]]
            .filter((other): other is string => at >= 0 && other !== undefined)
            .map((other) => slots.get(other) ?? slotOf(fileIndex.get(other) ?? -1, other, fileGenomes.length))
          slot = slotApart(slot, near)
          if (placed) slots.set(id, slot)
        }
        const colour = genomeColour(slot, kind, isDark)
        if (placed) colours.set(key, colour)
        return colour
      },
      shortName(id: string): string {
        stage.refreshPrefixes()
        // As drawn: a preview's new genome by the name the step gives it.
        const genome = drawn(id)
        if (genome === undefined) return id
        return shortName(genome.name, stage.prefixes[genome.kind])
      },
      prefixOf(kind: 'mag' | 'element'): string {
        stage.refreshPrefixes()
        return stage.prefixes[kind]
      },
      poolColour: { css: POOL_COLOUR, rgba: POOL_RGBA },
      ink(): StageInk {
        stage.inkHeld ??= stage.readFullInk()
        return stage.inkHeld
      },
      focus: (contigs) => this.props.requests.focus(contigs),
      say: (text) => {
        this.sayHeld = text
        this.paintReadout()
      },
      frame: (target) => {
        for (const listener of this.frameListeners) listener(target)
      },
      onFrame: (listener) => {
        this.frameListeners.add(listener)
        return () => this.frameListeners.delete(listener)
      },
      startDrag: (dragged, event) => this.startDrag(dragged, event),
      get dragging() {
        return stage.dragging
      },
      dropWords: (target) => {
        if (this.dragging === null) return null
        const plan = this.model.dropPlan(this.dragging, target)
        if (plan === null) return null
        return plan.refused !== undefined ? { words: plan.refused, refused: true } : { words: plan.words, refused: false }
      },
      drop: (target) => {
        if (this.dragging === null) return false
        const made = this.model.drop(this.dragging, target)
        this.endDrag()
        return made
      },
    }
  }

  /** The ink, with the colours the stage adds: `--warn`, `--ok`, `--border`. */
  private readFullInk(): StageInk {
    return readInk(this.root)
  }

  /** Each section's shared prefix, once per answer. */
  private refreshPrefixes(): void {
    const answer = this.model.answer
    if (answer === null || answer === this.prefixedFor) return
    this.prefixedFor = answer
    // The file's names set the prefix, so a genome a step makes does not move it.
    const file = this.props.store.file.genomes
    this.prefixes.mag = sharedPrefix(file.filter((genome) => genome.kind === 'mag').map((genome) => genome.name))
    this.prefixes.element = sharedPrefix(file.filter((genome) => genome.kind === 'element').map((genome) => genome.name))
  }

  // -------------------------------------------------------------------------
  // The contacts' read.
  // -------------------------------------------------------------------------

  private readNetwork(): void {
    this.network?.cancel()
    this.networkState = 'reading'
    this.showStatus('reading every contact between contigs…', 0, true)
    const request = this.props.requests.network((done, total) => {
      if (this.closed || this.network !== request) return
      this.progress(total > 0 ? done / total : null)
    })
    this.network = request
    request.promise.then(
      (summary) => {
        if (this.closed || this.network !== request) return
        this.network = null
        this.networkState = 'read'
        this.networkSummary = summary
        this.data.background = summary.background.rho
        this.hideStatus()
        this.model.recount(0)
      },
      (error: unknown) => {
        if (this.closed || this.network !== request) return
        this.network = null
        const cancelled = error instanceof Error && /cancel|abort/i.test(error.message)
        this.networkState = cancelled ? 'cancelled' : 'failed'
        this.showStatus(cancelled ? 'reading the contacts: cancelled' : `reading the contacts failed: ${error instanceof Error ? error.message : String(error)}`, null, false, {
          label: 'read them again',
          run: () => this.readNetwork(),
        })
      },
    )
  }

  private showGate(gate: { pixels: number; bytes: number | null }): void {
    this.networkState = 'gated'
    const sentence = `The maps, the hosts and the suggestions read every contact between contigs once: ${fmt.int(gate.pixels)} stored pixels${gate.bytes === null ? '' : `, ${fmt.bytes(gate.bytes)} to download`}.`
    this.showStatus(sentence, null, false, { label: 'read every contact', run: () => this.readNetwork() })
  }

  /** The row's text and bar, while it reads: moved on each report, never rebuilt, so its cancel keeps the focus. */
  private statusParts: { text: HTMLElement; fill: HTMLElement; words: string } | null = null
  /** What the status row says: the contacts' read, or a count that failed. */
  private statusOf: 'network' | 'count' | null = null

  private showStatus(text: string, fraction: number | null, cancellable: boolean, action?: { label: string; run: () => void }, of: 'network' | 'count' = 'network'): void {
    const bar = el('div', { class: 'curate-status-bar' })
    const fill = el('div', { class: 'curate-status-fill' })
    bar.appendChild(fill)
    const words = el('span', { class: 'curate-status-text' })
    const parts: HTMLElement[] = [words]
    if (cancellable) parts.push(bar, el('button', { class: 'btn-link', text: 'cancel', attrs: { type: 'button' }, on: { click: () => this.network?.cancel() } }))
    else if (action !== undefined) parts.push(el('button', { class: 'btn', text: action.label, attrs: { type: 'button' }, on: { click: action.run } }))
    this.status.replaceChildren(...parts)
    this.status.classList.remove('hidden')
    this.statusParts = cancellable ? { text: words, fill, words: text } : null
    this.statusOf = of
    if (cancellable) this.progress(fraction)
    else words.textContent = text
  }

  /** The read's bar and percentage, moved. */
  private progress(fraction: number | null): void {
    const parts = this.statusParts
    if (parts === null) return
    parts.fill.classList.toggle('is-waiting', fraction === null)
    parts.fill.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`
    parts.text.textContent = fraction === null ? parts.words : `${parts.words} ${Math.round(fraction * 100)}%`
  }

  private hideStatus(): void {
    this.status.classList.add('hidden')
    this.status.replaceChildren()
    this.statusParts = null
    this.statusOf = null
  }

  /** A count that failed, said, with a press to count again; gone with the next answer. */
  private paintCountError(): void {
    const error = this.model.error
    if (error !== null) {
      this.showStatus(`counting the binning failed: ${error}`, null, false, { label: 'count again', run: () => this.model.recount(0) }, 'count')
    } else if (this.statusOf === 'count') this.hideStatus()
  }

  // -------------------------------------------------------------------------
  // What changed.
  // -------------------------------------------------------------------------

  private changed(change: CurateChange): void {
    if (this.closed) return
    if (change === 'state' || change === 'error') this.paintCountError()
    if (change === 'state') this.fillCoverage()
    this.list.update(change)
    for (const pane of Object.values(this.panes)) pane.update(change)
    for (const card of this.cards) card.update(change)
    if (change === 'mode') this.arrangeSide()
    if (change === 'state' || change === 'mode' || change === 'current' || change === 'counting' || change === 'error' || change === 'preview') this.paintChrome()
    if (change === 'mode' || change === 'current' || change === 'state') this.followReview()
    // A drag, a chooser or a card let go of the preview the review priced its
    // question with: priced again, once nothing else holds one.
    if (change === 'preview' && this.model.mode === 'review' && this.model.previewSteps === null && this.dragging === null) this.repriceSoon()
    this.paintReadout()
  }

  private repricing = false

  private repriceSoon(): void {
    if (this.repricing) return
    this.repricing = true
    queueMicrotask(() => {
      this.repricing = false
      if (this.closed || this.dragging !== null || this.model.mode !== 'review' || this.model.previewSteps !== null) return
      const current = this.model.current
      if (current !== null) this.model.preview(current.steps, this.space)
    })
  }

  /** The scatter's height: Hi-C contacts per kb, once the contacts are read. */
  private fillCoverage(): void {
    const answer = this.model.answer
    if (answer === null || !answer.counted || this.data.coverage !== null) return
    const { lengths } = this.props.store.file
    const hits = answer.contigs.hits
    this.data.coverage = Float64Array.from(hits, (h, c) => ((lengths[c] ?? 0) > 0 ? h / ((lengths[c] ?? 0) / 1000) : 0))
  }

  /** The modes, undo and redo, and the review's band. */
  private paintChrome(): void {
    const model = this.model
    const offered = model.answer?.counted === true ? model.offered().length : 0
    for (const [mode, button] of Object.entries(this.modes) as Array<['manual' | 'review' | 'auto', HTMLButtonElement]>) {
      button.setAttribute('aria-pressed', String(model.mode === mode))
      button.disabled = mode !== 'manual' && offered === 0 && model.mode !== mode
      button.title = !button.disabled ? this.modeTitles[mode] : model.answer?.counted === true ? NOTHING_ON_OFFER : NOTHING_TO_ANSWER
    }
    this.undoButton.disabled = !this.props.store.canUndo
    this.redoButton.disabled = !this.props.store.canRedo
    this.paintBand()
  }

  private paintBand(): void {
    const model = this.model
    if (model.mode !== 'review') {
      this.band.classList.add('hidden')
      this.band.replaceChildren()
      return
    }
    this.band.classList.remove('hidden')
    // Three lines whatever is asked, each one line long (`stage.css`): where
    // the question stands, with the keys at the right; the question and how
    // sure; its price. From one question to the next nothing under it moves.
    const current = model.current
    const question = model.currentQuestion
    const keys = this.bandKeys(question !== null && question.members.length > 1)
    if (current === null) {
      // A count that failed leaves the queue of the binning before the step: nothing is asked of it, and the status row counts again.
      const words = model.stale ? 'weighing…' : model.error !== null ? 'the count failed: count again' : 'nothing left to answer'
      this.band.replaceChildren(
        el('div', { class: 'curate-band-head' }, el('span', { class: 'curate-band-at' }, el('span', { class: 'curate-band-where', text: 'review' })), keys),
        el('div', { class: 'curate-band-question' }, el('span', { class: 'curate-band-words', text: words })),
        el('div', { class: 'curate-band-price' }),
      )
      return
    }
    const queue = model.queue()
    const likely = queue.filter((q) => q.confidence >= LIKELY).length
    const less = queue.length - likely
    // Numbered as the pictures and the suggestions card number it (`curate/questions.ts`).
    const number = question === null ? 0 : (questionNumber(queue, question.key, LIKELY) ?? 0)
    const isLikely = question !== null && question.confidence >= LIKELY
    const member = model.member
    const odds = `${Math.round(LIKELY * 100)}%`
    // Where it stands, at the left of the keys: what does not fit whole there
    // — the less likely ones after — goes, never cut (`stage.css`).
    const at = el(
      'span',
      { class: 'curate-band-at' },
      el('span', {
        class: 'curate-band-where',
        text: isLikely ? `${fmt.int(number)} of ${fmt.int(likely)} likely` : `${fmt.int(number)} of ${fmt.int(less)} less likely`,
        title: isLikely
          ? `Question ${fmt.int(number)} of the ${fmt.int(likely)} likely ones, at ${odds} or more, which come first${less > 0 ? `; ${fmt.int(less)} less likely ones come after them` : ''}.`
          : `Question ${fmt.int(number)} of the ${fmt.int(less)} less likely ones, under ${odds}, which come after the likely ones.`,
      }),
      ...(member === null ? [] : [el('span', { class: 'curate-band-member', text: `· ${member.at + 1} of its ${member.of}`, title: `Member ${member.at + 1} of ${member.of}, answered alone.` })]),
      ...(isLikely && less > 0 ? [el('span', { class: 'curate-band-after', text: `· ${fmt.int(less)} less likely after` })] : []),
    )
    const head = el('div', { class: 'curate-band-head' }, at, keys)
    const ask = el('div', { class: 'curate-band-question' }, this.bandWords(current), el('span', { class: 'curate-band-confidence', text: `· ${displayPercent(current.confidence)}%` }))
    this.band.replaceChildren(head, ask, this.bandPrice(current, 'whole'))
    this.fitBandPrice()
  }

  /**
   * The price in the first form its line holds whole: every genome's sum and
   * the words; each genome's own numbers alone (before → after, the summands
   * in its title); the numbers alone, without their words — then cut short
   * genome by genome (`stage.css`). Asked again when the centre is resized.
   */
  private fitBandPrice(): void {
    const current = this.model.mode === 'review' ? this.model.current : null
    let price = this.band.querySelector<HTMLElement>(':scope > .curate-band-price')
    if (current === null || price === null) return
    const cut = (node: HTMLElement): boolean => node.scrollWidth > node.clientWidth + 1
    for (const form of BAND_FORMS) {
      if (form !== price.dataset.form) {
        const next = this.bandPrice(current, form)
        price.replaceWith(next)
        price = next
      }
      // Whole: nothing past the line's end, no genome's numbers cut short.
      if (!cut(price) && ![...price.querySelectorAll<HTMLElement>('.curate-band-price-numbers')].some(cut)) return
    }
  }

  /**
   * The band's keys, the same five on every question so the line never moves:
   * ↓ ↑ dimmed on a question of one member, and Space lit while it is held.
   */
  private bandKeys(members: boolean): HTMLElement {
    // Its caps among its words — `hold ␣ to preview` —; a word `kept` stays
    // where a narrow band lets the others go (`stage.css`).
    const key = (title: string, parts: Array<string | { cap: string } | { kept: string }>, state = ''): HTMLElement => {
      const node = el('span', { class: `curate-band-key${state === '' ? '' : ` ${state}`}`, title })
      for (const part of parts) {
        if (typeof part === 'string') node.append(el('span', { class: 'curate-band-key-word', text: part }))
        else if ('cap' in part) node.append(keyBadge(part.cap, { class: 'kbd-inline' }))
        else node.append(el('span', { class: 'curate-band-key-word is-kept', text: part.kept }))
      }
      return node
    }
    const held = this.space && this.model.previewing
    return el(
      'span',
      { class: 'curate-band-keys' },
      key('Take the question whole, one step to undo', [{ cap: 'y' }, 'take']),
      key('Turn every member down', [{ cap: 'n' }, 'turn down']),
      key('The previous or the next question', [{ cap: '←' }, { cap: '→' }, 'others']),
      key(members ? 'Its members one by one, each answered alone' : 'One member: nothing to answer one by one', [{ cap: '↓' }, { cap: '↑' }, 'one by one'], members ? '' : 'is-off'),
      key('Hold Space to draw every picture as the question would leave the binning', ['hold', { cap: ' ' }, 'to', { kept: 'preview' }], held ? 'is-held' : ''),
    )
  }

  /**
   * The band's price, one line: every MAG the question changes, before →
   * after, in the cards' numbers (`cards/card.ts` → `priceList`: a genome's
   * own, plus those it takes in whole — a move's target is not summed with
   * the genome the contigs leave), the one taking contigs in first. Each
   * number that moves the grade wears its colour (`qualityShift`), as the
   * cards' do, and so do the name and the verdict; a row gives way where the
   * line is full, the first last, whole in its title. Then one chip counting
   * the markers it makes present twice, named in its title.
   */
  private bandPrice(current: Question, form: BandForm): HTMLElement {
    const model = this.model
    const price = el('div', { class: 'curate-band-price', attrs: { 'data-form': form } })
    const before = model.answer
    const after = model.previewed
    if (before === null || after === null || JSON.stringify(model.previewSteps) !== JSON.stringify(current.steps)) {
      price.append(el('span', { class: 'curate-band-price-none', text: 'pricing…' }))
      return price
    }
    const contigsAfter = new Map(after.genomes.map((genome) => [genome.id, genome.contigs]))
    const takesIn = (row: PriceRow): boolean => {
      const self = row.from.find((from) => from.id === row.id)
      return self === undefined || (contigsAfter.get(row.id) ?? 0) > self.contigs
    }
    const rows = priceOf(before, after)
      .filter((row) => row.kind === 'mag' && row.after !== null)
      .map((row, at) => ({ row, at, gains: takesIn(row), moved: priceVerdict(row) !== null }))
      .sort((x, y) => Number(y.gains) - Number(x.gains) || Number(y.moved) - Number(x.moved) || x.at - y.at)
      .map(({ row }) => row)
    if (rows.length === 0) {
      // A link moves no contig; a merge or a move of MAGs without markers has nothing to price it by.
      price.append(el('span', { class: 'curate-band-price-none', text: current.kind === 'link' || current.kind === 'unlink' ? 'no genome’s quality changes' : 'no marker genes to price it by' }))
      return price
    }
    const present = new Set(after.genomes.map((genome) => genome.id))
    const twice: Array<{ name: string; markers: string[] }> = []
    for (const [k, row] of rows.slice(0, BAND_PRICED).entries()) {
      // The first row says what its numbers are; the next ones, in the same order, are numbers only.
      price.append(this.bandPriceRow(row, present, form, k === 0))
      // What a rise in redundancy is made of: two organisms, or a contig the
      // genome has the like of already.
      const markers = newlyDuplicated(row)
      if (markers.length > 0) twice.push({ name: row.name, markers })
    }
    const rest = rows.slice(BAND_PRICED)
    if (rest.length > 0) price.append(el('span', { class: 'curate-band-price-more', text: `+ ${fmt.int(rest.length)} more`, title: rest.map((row) => row.name).join(', ') }))
    const count = new Set(twice.flatMap((t) => t.markers)).size
    if (count > 0)
      price.append(
        el('span', {
          class: 'edit-chip curate-band-twice',
          text: `${count === 1 ? 'a marker' : `${fmt.int(count)} markers`} twice`,
          title: `Present twice once taken, where they were once: ${twice.map((t) => `${t.name}: ${t.markers.join(', ')}`).join('; ')}`,
        }),
      )
    return price
  }

  /**
   * One MAG's price in the band: `00700_00001 complete 84% + 12% → 84% ·
   * redundant 1.04 + 1.00 → 1.06 · a grade lower`, summed as the cards sum
   * it — the genome itself, then the genomes it takes in whole that bring a
   * marker of the set, three at most and how many more; in the `unsummed`
   * form its own numbers alone, before → after. Not `worded`, or in the
   * `bare` form, the numbers without their words (`12% → 7% · 1.16 →
   * 1.00`). The title is always whole. The verdict stands apart from the
   * numbers, which give way before it does: a row cut short still says what
   * becomes of the grade.
   */
  private bandPriceRow(row: PriceRow, present: ReadonlySet<string>, form: BandForm, worded: boolean): HTMLElement {
    const q = row.after as Quality
    const parts = row.from.filter((from) => from.id === row.id || !present.has(from.id))
    const telling = parts.filter((from, k): from is PriceRow['from'][number] & { quality: Quality } => from.quality !== null && (k === 0 || from.quality.weightedCompleteness > 0)).slice(0, BAND_SUMMANDS)
    const more = parts.length - telling.length
    const own = parts[0]?.quality ?? null
    const summed = (pick: (quality: Quality) => number, print: (x: number) => string): string =>
      telling.length === 0 ? print(pick(q)) : `${telling.map((from) => print(pick(from.quality))).join(' + ')}${more > 0 ? ` + ${fmt.int(more)} more` : ''} → ${print(pick(q))}`
    const sum = (pick: (quality: Quality) => number, print: (x: number) => string): string =>
      form === 'whole' ? summed(pick, print) : own === null ? print(pick(q)) : `${print(pick(own))} → ${print(pick(q))}`
    const shift = qualityShift(parts[0]?.quality ?? null, q)
    const verdict = priceVerdict(row)
    const word = verdict === 'demoted' ? (row.gradeAfter === 'contaminated' ? 'contaminated' : 'a grade lower') : verdict === 'promoted' ? 'high quality' : null
    const marked = (shifted: Shift): string => (shifted === null ? '' : ` is-${shifted}`)
    const completeness = sum((x) => x.weightedCompleteness, (x) => fmt.pct(x, 0))
    const redundancy = sum((x) => x.weightedRedundancy, redundancyText)
    const named = worded && form !== 'bare'
    const numbers = el(
      'span',
      { class: 'curate-band-price-numbers' },
      el('span', { class: `curate-band-price-name${marked(verdict)}`, text: this.ctx.shortName(row.id) }),
      ' ',
      el('span', { class: `curate-band-price-number${marked(shift.completeness)}`, text: named ? `complete ${completeness}` : completeness }),
      ' · ',
      el('span', { class: `curate-band-price-number${marked(shift.redundancy)}`, text: named ? `redundant ${redundancy}` : redundancy }),
    )
    const whole = `${row.name}: complete ${summed((x) => x.weightedCompleteness, (x) => fmt.pct(x, 0))} · redundant ${summed((x) => x.weightedRedundancy, redundancyText)}${word === null ? '' : ` · ${word}`}`
    const node = el('span', { class: 'curate-band-price-row', title: whole }, numbers)
    if (word !== null) node.append(el('span', { class: 'curate-band-price-grade' }, ' · ', el('span', { class: `curate-band-price-verdict${marked(verdict)}`, text: word })))
    return node
  }

  /**
   * A question's words as the list names what they name: each genome by its
   * short name after its swatch — a MAG's disc, an element's ring, in its
   * colour — so an element's bare number (`00002`) is not read as a MAG
   * family's; a contig by an assembler's name without its length (`NODE_622`
   * for `NODE_622_len_49741`). The whole words are the title's.
   */
  private bandWords(s: Suggestion): HTMLElement {
    const node = el('span', { class: 'curate-band-words', title: s.words })
    const answer = this.model.answer
    const swaps = new Map<string, () => Node>()
    for (const g of s.genomes) {
      const genome = answer?.genomes[g]
      if (genome === undefined || !s.words.includes(genome.name)) continue
      swaps.set(genome.name, () =>
        el('span', { class: `curate-band-name is-${genome.kind}` }, swatch(this.ctx.colourOf(genome.id).css, genome.kind), this.ctx.shortName(genome.id)),
      )
    }
    const names = this.props.store.file.names
    for (const c of s.contigs) {
      const name = names[c]
      if (name === undefined || swaps.has(name) || !s.words.includes(name)) continue
      const short = contigShortName(name)
      if (short !== name) swaps.set(name, () => document.createTextNode(short))
    }
    if (swaps.size === 0) {
      node.textContent = s.words
      return node
    }
    // Whole names only, the longest first: `NODE_1_len_100` is not the start of `NODE_1_len_1000`.
    const pattern = [...swaps.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
    const pieces = s.words.split(new RegExp(`(?<![\\w.])(${pattern})(?![\\w.])`))
    // Split on a pattern with one group, the names are at the odd places.
    pieces.forEach((piece, k) => {
      if (piece === '') return
      const swap = k % 2 === 1 ? swaps.get(piece) : undefined
      node.append(swap === undefined ? piece : swap())
    })
    return node
  }

  /** In review: price the current suggestion, frame it, and put the large picture where its evidence is. */
  private followReview(): void {
    const model = this.model
    if (model.mode !== 'review') {
      for (const pane of Object.values(this.panes)) pane.showSuggestion(null)
      if (this.large !== this.chosen) this.setLarge(this.chosen)
      this.framedKey = null
      return
    }
    const current = model.current
    for (const pane of Object.values(this.panes)) pane.showSuggestion(current)
    if (current === null) return
    model.preview(current.steps, this.space)
    // Framed when the question changes, not on every count: the reader's row
    // in the list stays where they took it.
    if (current.key === this.framedKey) return
    this.framedKey = current.key
    this.setLarge(current.kind === 'link' || current.kind === 'unlink' ? 'hosts' : 'contacts')
    this.ctx.frame({
      genomes: current.genomes.map((g) => model.answer?.genomes[g]?.id).filter((id): id is string => id !== undefined),
      contigs: current.contigs,
    })
  }

  /** The question review framed last. */
  private framedKey: string | null = null

  /**
   * The readout: what a part said, the drag's words, or the curation's tally.
   * While the pictures draw a preview — Space held in review, a drop or a
   * suggestion's row resting — it says so first, a pill, and its tally is the
   * binning's as it would be against the binning as it is (`MAGs 50 → 49 ·
   * … · if taken`); the pictures stand in a frame of the accent.
   */
  private paintReadout(): void {
    const previewing = this.model.previewing
    this.centre.classList.toggle('is-previewing', previewing)
    this.readout.classList.toggle('is-previewing', previewing)
    const pill = previewing
      ? [el('span', { class: 'curate-readout-pill', text: 'as it would be', title: 'Every picture draws the binning as the question or the drop would leave it; nothing is made until it is taken.' })]
      : []
    if (this.sayHeld !== null) {
      this.readout.replaceChildren(...pill, this.sayHeld)
      this.readout.classList.remove('is-summary')
      return
    }
    this.readout.classList.add('is-summary')
    const answer = this.model.answer
    if (answer === null) {
      this.readout.textContent = 'weighing…'
      return
    }
    const counts = (of: CurationStateResult): { mags: number; elements: number; pooled: number } => {
      const mags = of.genomes.filter((genome) => genome.kind === 'mag').length
      let pooled = 0
      of.genomeOf.forEach((g) => {
        if (g < 0) pooled++
      })
      return { mags, elements: of.genomes.length - mags, pooled }
    }
    const now = counts(answer)
    const was = (to: number, from: number, one: string, many: string): string => (to === from ? counted(to, one, many) : `${many} ${fmt.int(from)} → ${fmt.int(to)}`)
    const shown = this.model.shown
    if (previewing && shown !== null) {
      // As it would be, against the binning as it is.
      const would = counts(shown)
      const parts = [was(would.mags, now.mags, 'MAG', 'MAGs'), was(would.elements, now.elements, 'element', 'elements'), was(would.pooled, now.pooled, 'unbinned', 'unbinned'), 'if taken']
      this.readout.replaceChildren(...pill, parts.join(' · '))
      return
    }
    const tally = this.model.tally()
    const file = this.model.fileAnswer
    const fileMags = file?.genomes.filter((genome) => genome.kind === 'mag').length ?? now.mags
    const fileElements = (file?.genomes.length ?? answer.genomes.length) - fileMags
    const parts = [was(now.mags, fileMags, 'MAG', 'MAGs'), was(now.elements, fileElements, 'element', 'elements'), `${fmt.int(now.pooled)} unbinned`]
    if (tally === null || tally.steps === 0) parts.push('as in the file')
    else {
      parts.push(counted(tally.steps, 'step'))
      if (tally.contigsMoved > 0) parts.push(`${counted(tally.contigsMoved, 'contig')} moved`)
      if (tally.linksAdded + tally.linksDropped > 0) parts.push(`links +${tally.linksAdded} −${tally.linksDropped}`)
    }
    if (this.model.stale) parts.push('weighing…')
    this.readout.textContent = parts.join(' · ')
  }

  // -------------------------------------------------------------------------
  // The pictures' places.
  // -------------------------------------------------------------------------

  private choose(name: PaneName): void {
    this.chosen = name
    remember(this.props.memoryKey(), 'curate:large', name)
    this.setLarge(name)
  }

  private setLarge(name: PaneName): void {
    if (name === this.large && this.paneArea.childElementCount > 0) return
    this.large = name
    this.place()
  }

  /** Put the large picture in its place and the other two beside it. */
  private place(): void {
    const order = [this.large, ...PANES.filter((name) => name !== this.large)]
    const slots: HTMLElement[] = order.map((name, k) => {
      const pane = this.panes[name]
      const slot = el('div', { class: `curate-slot ${k === 0 ? 'is-large' : 'is-small'}`, attrs: { 'data-slot': name } })
      if (k > 0) {
        const head = el(
          'button',
          {
            class: 'curate-slot-head',
            title: withKey(`Show the ${PANE_WORD[name]} large`, PANE_KEY[name]),
            attrs: { type: 'button' },
            on: { click: () => this.choose(name) },
          },
          el('span', { text: PANE_WORD[name] }),
          keyBadge(PANE_KEY[name], { class: 'kbd-inline' }),
        )
        slot.appendChild(head)
      }
      slot.appendChild(pane.element)
      pane.setLarge(k === 0)
      return slot
    })
    this.paneArea.replaceChildren(...slots)
    for (const tab of this.tabs.querySelectorAll<HTMLElement>('[data-pane-tab]')) tab.setAttribute('aria-pressed', String(tab.dataset.paneTab === this.large))
    requestAnimationFrame(() => {
      for (const pane of Object.values(this.panes)) pane.resize()
    })
  }

  private resized(): void {
    const width = this.centre.clientWidth
    this.centre.classList.toggle('is-narrow', width > 0 && width < NARROW)
    this.centre.classList.toggle('is-tight', width > 0 && width < TIGHT)
    for (const pane of Object.values(this.panes)) pane.resize()
    // The band's price in the form its new width holds, from the whole again.
    const price = this.band.querySelector<HTMLElement>(':scope > .curate-band-price')
    const current = this.model.mode === 'review' ? this.model.current : null
    if (price !== null && current !== null && price.dataset.form !== 'whole') price.replaceWith(this.bandPrice(current, 'whole'))
    this.fitBandPrice()
  }

  private wireGrip(grip: HTMLElement, column: HTMLElement): void {
    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      grip.setPointerCapture(event.pointerId)
      const start = event.clientX
      const from = column.getBoundingClientRect().width
      const move = (moved: PointerEvent): void => {
        column.style.width = `${Math.max(220, Math.min(480, from + moved.clientX - start))}px`
      }
      const up = (): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        remember(this.props.memoryKey(), 'curate:list', column.getBoundingClientRect().width)
        this.resized()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
    grip.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const now = column.getBoundingClientRect().width
      column.style.width = `${Math.max(220, Math.min(480, now + (event.key === 'ArrowLeft' ? -24 : 24)))}px`
      remember(this.props.memoryKey(), 'curate:list', column.getBoundingClientRect().width)
      this.resized()
    })
  }

  // -------------------------------------------------------------------------
  // The inspector.
  // -------------------------------------------------------------------------

  private modeButton(mode: 'manual' | 'review' | 'auto', title: string): HTMLButtonElement {
    return el('button', {
      class: 'btn btn-toggle',
      text: mode,
      title,
      attrs: { type: 'button', 'aria-pressed': String(mode === 'manual'), 'data-mode': mode },
      on: {
        click: () => {
          this.model.setMode(mode)
          // The keyboard back to the list: Space on the button pressed it again
          // instead of holding the review's preview.
          this.list.focus()
        },
      },
    })
  }

  /** The cards in the mode's order, moved, never rebuilt (as the reference stage's). */
  private arrangeSide(): void {
    const mode = this.model.mode
    const c = this.cardOf
    const order =
      mode === 'manual'
        ? [c.selection, c.history, c.suggestions, c.export, c.about]
        : mode === 'review'
          ? [c.suggestions, c.selection, c.history, c.export, c.about]
          : [c.suggestions, c.history, c.selection, c.export, c.about]
    for (const card of order) this.side.appendChild(card.element)
  }

  /**
   * The inspector's toggle, docked at the toolbar's end beside the keys: the
   * dialog's shell floats it over the side's foot, where it sat on whatever
   * card was scrolled under it. Moved, not rebuilt — its press is the shell's —
   * and named, with the shell's grip, for what they move here: the inspector.
   */
  private dockSideToggle(): void {
    const shell = this.root.closest('.stage-modal')
    if (shell === null) return
    const children = [...shell.children] as HTMLElement[]
    const toggle = children.find((node) => node.classList.contains('stage-side-toggle'))
    const side = children.find((node) => node.classList.contains('stage-side'))
    const grip = children.find((node) => node.classList.contains('stage-side-grip'))
    if (grip !== undefined) {
      grip.title = 'Drag to make the inspector wider or narrower'
      grip.setAttribute('aria-label', 'Resize the inspector')
    }
    if (toggle === undefined || side === undefined) return
    this.tools.appendChild(toggle)
    const name = (): void => {
      const words = side.classList.contains('hidden') ? 'Show the inspector' : 'Hide the inspector'
      toggle.title = words
      toggle.setAttribute('aria-label', words)
    }
    name()
    // After the shell's own listener, which names it for its settings.
    toggle.addEventListener('click', name)
  }

  private frameSuggestion(s: Suggestion): void {
    const answer = this.model.answer
    if (this.model.mode === 'review') this.model.setCurrent(s.key)
    this.ctx.frame({ genomes: s.genomes.map((g) => answer?.genomes[g]?.id).filter((id): id is string => id !== undefined), contigs: s.contigs })
    for (const pane of Object.values(this.panes)) pane.showSuggestion(s)
  }

  // -------------------------------------------------------------------------
  // The drag in flight.
  // -------------------------------------------------------------------------

  private startDrag(dragged: CurateDragged, event: PointerEvent): void {
    this.endDrag()
    this.dragging = dragged
    const count = dragged.kind === 'contigs' ? dragged.contigs.length : dragged.ids.length
    const words =
      dragged.kind === 'contigs'
        ? count === 1
          ? (this.props.store.file.names[dragged.contigs[0]] ?? 'a contig')
          : `${fmt.int(count)} contigs · ${fmt.bp(dragged.contigs.reduce((sum, c) => sum + (this.props.store.file.lengths[c] ?? 0), 0))}`
        : count === 1
          ? this.ctx.shortName(dragged.ids[0])
          : `${fmt.int(count)} genomes`
    const ghost = el('div', { class: 'curate-ghost', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'curate-ghost-what', text: words }), el('span', { class: 'curate-ghost-step' }))
    document.body.appendChild(ghost)
    document.body.classList.add('is-curate-dragging')
    let lit: HTMLElement | null = null
    let target: CurateDropTarget | null = null
    let rest = 0
    const place = (x: number, y: number): void => {
      ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`
    }
    place(event.clientX, event.clientY)
    const move = (moved: PointerEvent): void => {
      place(moved.clientX, moved.clientY)
      const found = this.dropTargetAt(moved.clientX, moved.clientY)
      lit?.classList.remove('is-drop-target')
      lit = found.element
      lit?.classList.add('is-drop-target')
      const next = found.target
      if (JSON.stringify(next) === JSON.stringify(target)) return
      target = next
      window.clearTimeout(rest)
      this.model.preview(null)
      const step = ghost.querySelector('.curate-ghost-step') as HTMLElement
      if (target === null) {
        step.textContent = ''
        ghost.classList.remove('is-refused', 'is-ready')
        this.ctx.say(null)
        return
      }
      const plan = this.model.dropPlan(dragged, target)
      if (plan === null) return
      if (plan.refused !== undefined) {
        step.textContent = plan.refused
        ghost.classList.add('is-refused')
        ghost.classList.remove('is-ready')
        this.ctx.say(plan.refused)
        return
      }
      step.textContent = plan.words
      ghost.classList.add('is-ready')
      ghost.classList.remove('is-refused')
      this.ctx.say(`drop to ${plan.words}`)
      // Resting on a target draws it made, every step of it.
      const steps = plan.steps
      rest = window.setTimeout(() => this.model.preview(steps, true), DROP_PREVIEW_MS)
    }
    const up = (released: PointerEvent): void => {
      const found = this.dropTargetAt(released.clientX, released.clientY).target
      if (found !== null && this.dragging !== null) {
        this.model.drop(this.dragging, found)
      }
      this.endDrag()
    }
    // A gesture the browser took over — a touch turned into a scroll — ends
    // the drag where it is, dropping nothing.
    const cancel = (): void => this.endDrag()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    window.addEventListener('pointercancel', cancel, { once: true })
    this.dragEnd = () => {
      window.clearTimeout(rest)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      lit?.classList.remove('is-drop-target')
      ghost.remove()
      document.body.classList.remove('is-curate-dragging')
    }
  }

  private endDrag(): void {
    if (this.dragEnd === null && this.dragging === null) return
    this.dragEnd?.()
    this.dragEnd = null
    this.dragging = null
    this.model.preview(null)
    this.ctx.say(null)
    // In review, the question's price again: the drag's preview replaced it.
    if (this.model.mode === 'review') this.repriceSoon()
  }

  /** What is under a point: a list row or section head, or a picture's target. */
  private dropTargetAt(x: number, y: number): { target: CurateDropTarget | null; element: HTMLElement | null } {
    const under = document.elementFromPoint?.(x, y) as HTMLElement | null
    const row = under?.closest?.('[data-drop-genome], [data-drop-section]') as HTMLElement | null | undefined
    if (row !== null && row !== undefined && this.root.contains(row)) {
      const genome = row.dataset.dropGenome
      if (genome !== undefined) return { target: { kind: 'genome', id: genome }, element: row }
      const section = row.dataset.dropSection
      if (section === 'pool') return { target: { kind: 'pool' }, element: row }
      if (section === 'mags' || section === 'elements') return { target: { kind: 'section', section }, element: row }
    }
    for (const pane of Object.values(this.panes)) {
      const box = pane.element.getBoundingClientRect()
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue
      return { target: pane.dropTargetAt(x, y), element: null }
    }
    return { target: null, element: null }
  }

  // -------------------------------------------------------------------------
  // Acts the keys make.
  // -------------------------------------------------------------------------

  /** The selected genomes' contigs, close up: the contact map large, and kept large by the steps made there. */
  private closeUp(): void {
    this.chosen = 'contacts'
    this.setLarge('contacts')
    this.panes.contacts.closeUp?.()
  }

  private openChooser(kind: 'move' | 'merge' | 'link', at?: HTMLElement): void {
    this.chooser?.close()
    let anchor: HTMLElement | { x: number; y: number } = at ?? (this.cardOf.selection.element.querySelector('.edit-act') as HTMLElement | null) ?? this.cardOf.selection.element
    // Opened by a key, under the selection card's act where it is in view; the
    // card scrolled away (in review the suggestions come first), at the
    // pictures' corner, where the reader is looking.
    if (at === undefined && anchor instanceof HTMLElement) {
      const rect = anchor.getBoundingClientRect()
      if (rect.width === 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) {
        const box = this.paneArea.getBoundingClientRect()
        anchor = { x: box.left + 16, y: box.top + 16 }
      }
    }
    this.chooser = this.props.parts.chooser(this.ctx, kind, anchor, (target) => {
      this.chooser = null
      // As the chooser planned it: one MAG selected, the element chosen is linked to it.
      chooseStep(this.ctx, kind, target)
    })
  }

  /** The stage's keys; `true` when taken. */
  private key(event: KeyboardEvent): boolean {
    if (this.closed) return false
    // In review the arrows are the review's, as its band prints them: the
    // questions ← →, a question's members ↓ ↑ — before the list's.
    if (this.model.mode === 'review' && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.startsWith('Arrow')) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        this.model.moveCurrent(event.key === 'ArrowRight' ? 1 : -1)
        return true
      }
      return this.model.moveMember(event.key === 'ArrowDown' ? 1 : -1) || true
    }
    // The list's own keys while it has the keyboard.
    if (this.list.contains(event.target) && this.list.key(event)) return true
    // A picture's own — zoom, fit, its level — where the pointer is. An Escape
    // a picture took (a press or a lasso let go of) is the innermost thing:
    // the stage's own Escape, which the dialog asks next, stands down.
    const over = this.paneUnderPointer()
    if (over !== null && over.key(event)) {
      if (event.key === 'Escape') this.escapeTaken()
      return true
    }
    const mod = event.metaKey || event.ctrlKey
    const key = event.key
    const model = this.model
    const selection = model.selection
    if (mod) {
      if (key === 'z' || key === 'Z') {
        if (event.shiftKey) model.redo()
        else model.undo()
        return true
      }
      if (key === 'y' || key === 'Y') {
        model.redo()
        return true
      }
      return false
    }
    if (event.altKey) return false
    // The digits by the key they are printed on, whatever the layout types
    // there: AZERTY's bare `&` is its 1 (§16.5's digit row).
    const digit = /^Digit([123])$/.exec(event.code)?.[1] ?? (key === '1' || key === '2' || key === '3' ? key : null)
    if (digit !== null && !event.shiftKey) {
      this.choose(PANES[Number(digit) - 1])
      return true
    }
    switch (key) {
      case 'y':
      case 'Y':
      case 'n':
      case 'N': {
        // Held down, a key repeats: one press is one answer.
        if (event.repeat) return true
        const current = model.current
        if (current === null) return false
        if (key === 'y' || key === 'Y') model.accept(current)
        else model.reject(current)
        return true
      }
      case ' ':
        if (model.mode !== 'review' || model.current === null) return false
        if (!event.repeat) {
          this.space = true
          model.preview(model.current.steps, true)
          model.drawPreview(true)
        }
        return true
      case 'm':
      case 'M':
        if (selection.genomes.length === 0 && selection.contigs.length === 0) return false
        if (!this.mayStep()) return true
        if (selection.genomes.length >= 2 && selection.contigs.length === 0) {
          if (!model.mergeSelected()) this.flash('Merge MAGs with MAGs and elements with elements.')
        } else if (selection.contigs.length > 0) this.openChooser('move')
        else this.openChooser('merge')
        return true
      case 'l':
      case 'L': {
        if ((selection.genomes.length > 0 || selection.contigs.length > 0) && !this.mayStep()) return true
        if (this.linkSelected()) return true
        // The chooser lists the MAGs for elements, or the elements for one MAG.
        const kinds = selection.genomes.map((id) => model.answer?.genomes.find((genome) => genome.id === id)?.kind)
        const elements = kinds.length > 0 && kinds.every((kind) => kind === 'element')
        const oneMag = kinds.length === 1 && kinds[0] === 'mag'
        if (selection.contigs.length > 0 || !(elements || oneMag)) {
          this.flash('Select an element to link to a MAG, or one MAG to link elements to.')
          return true
        }
        this.openChooser('link')
        return true
      }
      case 'b':
      case 'B':
      case 'e':
      case 'E': {
        const kind = key === 'b' || key === 'B' ? 'mag' : 'element'
        if (selection.genomes.length === 0 && selection.contigs.length === 0) return false
        if (!this.mayStep()) return true
        if (selection.contigs.length > 0) {
          const id = model.createFromSelected(kind)
          // Its name open for typing once it is counted and has a row.
          if (id !== null) this.list.startRename(id)
        } else model.retypeSelected(kind)
        return true
      }
      case 'Delete':
      case 'Backspace':
        if (selection.genomes.length === 0 && selection.contigs.length === 0) return false
        if (!this.mayStep()) return true
        if (selection.contigs.length > 0) return model.moveSelected(null)
        if (this.unlinkSelected()) return true
        if (selection.genomes.length > 0) return model.dissolveSelected()
        return false
      case 'F2':
      case 'r':
      case 'R':
        if (selection.genomes.length !== 1) return false
        this.list.startRename(selection.genomes[0])
        return true
      case 'Enter':
        if (event.shiftKey) this.panes.contacts.back?.()
        else this.closeUp()
        return true
      case '/':
        this.list.focusFilter()
        return true
      case '?':
        this.showKeys()
        return true
      default:
        return false
    }
  }

  /**
   * Whether a key the selection card prints may make its step now — as the
   * card's act may (§33.3, *One answer a press*): not while the last step is
   * counted, nor after a count that failed, when what the stage shows is the
   * binning before it and a second press would make the step twice. Refused,
   * the key is taken all the same and the card dims, as for its act.
   */
  private mayStep(): boolean {
    if (this.model.answerable) return true
    this.cardOf.selection.element.classList.add('is-waiting')
    return false
  }

  private keyUp(event: KeyboardEvent): void {
    if (event.key === ' ' && this.space) this.letGo()
  }

  private letGo(): void {
    if (!this.space) return
    this.space = false
    this.model.drawPreview(false)
  }

  /** Link the selected element to the selected MAG: `L`. */
  private linkSelected(): boolean {
    const answer = this.model.answer
    if (answer === null) return false
    const kinds = new Map(answer.genomes.map((genome) => [genome.id, genome.kind]))
    const chosen = this.model.selection.genomes
    const elements = chosen.filter((id) => kinds.get(id) === 'element')
    const mags = chosen.filter((id) => kinds.get(id) === 'mag')
    if (elements.length === 0 || mags.length !== 1) return false
    const steps = elements.filter((element) => !answer.links.some((link) => link.element === element && link.mag === mags[0])).map((element) => ({ op: 'link' as const, element, mag: mags[0] }))
    if (steps.length === 0) return false
    // One link on offer: taken as the card's act takes it — the suggestion's,
    // learned — so the key printed on the act does what the act does (§26.4).
    if (steps.length === 1) {
      const only = steps[0]
      const offer = this.model.offered().find((s) => s.step.op === 'link' && s.step.element === only.element && s.step.mag === only.mag)
      if (offer !== undefined) return this.model.accept(offer)
    }
    return this.model.drop({ kind: 'genomes', ids: elements }, { kind: 'genome', id: mags[0] })
  }

  /** Unlink the selected element from the selected MAG, where they are linked: Delete. */
  private unlinkSelected(): boolean {
    const answer = this.model.answer
    const chosen = this.model.selection.genomes
    if (answer === null || chosen.length !== 2) return false
    const link = answer.links.find((l) => chosen.includes(l.element) && chosen.includes(l.mag))
    if (link === undefined) return false
    // An unlink on offer is taken as the card's act takes it (§26.4).
    const offer = this.model.offered().find((s) => s.step.op === 'unlink' && s.step.element === link.element && s.step.mag === link.mag)
    if (offer !== undefined) return this.model.accept(offer)
    return this.model.link(link.element, link.mag, false)
  }

  private paneUnderPointer(): CuratePane | null {
    for (const pane of Object.values(this.panes)) {
      const box = pane.element.getBoundingClientRect()
      if (box.width === 0) continue
      if (this.pointer.x >= box.left && this.pointer.x <= box.right && this.pointer.y >= box.top && this.pointer.y <= box.bottom) return pane
      if (pane.element.contains(document.activeElement)) return pane
    }
    return null
  }

  /** An Escape a part took; the dialog's call to {@link escape} for the same press finds it so. */
  private escapeHeld = false

  private escapeTaken(): void {
    this.escapeHeld = true
    queueMicrotask(() => {
      this.escapeHeld = false
    })
  }

  /** Escape: the innermost thing, never the stage. */
  private escape(): void {
    if (this.escapeHeld) {
      this.escapeHeld = false
      return
    }
    const sheet = this.root.querySelector('.curate-keys')
    if (sheet !== null) {
      sheet.remove()
      return
    }
    if (this.chooser !== null) {
      // One that closed itself (a press outside it) is let go of, and Escape goes on.
      const open = this.chooser.open !== false
      this.chooser.close()
      this.chooser = null
      if (open) return
    }
    if (this.dragging !== null) {
      this.endDrag()
      return
    }
    if (this.list.isRenaming) return
    // A field's Escape: its text gone, then the keyboard back to the list — the selection stays.
    const typing = document.activeElement
    if ((typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) && this.root.parentElement?.closest('.modal-backdrop')?.contains(typing) === true) {
      if (typing.value !== '') {
        typing.value = ''
        typing.dispatchEvent(new Event('input', { bubbles: true }))
      } else this.list.focus()
      return
    }
    if (this.model.running) {
      this.model.stopAuto()
      return
    }
    if (this.model.previewSteps !== null && this.model.mode !== 'review') {
      this.model.preview(null)
      return
    }
    const selection = this.model.selection
    if (selection.genomes.length > 0 || selection.contigs.length > 0) this.model.clearSelection()
  }

  /** A word in the readout for a moment: why a key made nothing. */
  private flash(text: string): void {
    this.ctx.say(text)
    window.setTimeout(() => {
      if (this.sayHeld === text) this.ctx.say(null)
    }, 2600)
  }

  /** The keys, in a popover. */
  private showKeys(): void {
    const existing = this.root.querySelector('.curate-keys')
    if (existing !== null) {
      existing.remove()
      return
    }
    const rows: Array<[string[], string]> = [
      [['1', '2', '3'], 'the contacts, the hosts or the scatter large'],
      [['y', 'n'], 'take or turn down the question in review'],
      [['←', '→'], 'the previous or next question, in review'],
      [['↓', '↑'], 'a question’s members one by one, in review'],
      [[' '], 'hold, in review, to preview: every picture as the question would leave the binning'],
      [['m'], 'merge the selected genomes; move the selected contigs to…'],
      [['l'], 'link the selected element to the selected MAG'],
      [['b', 'e'], 'a new MAG, a new element, of the selected contigs'],
      [['⌫'], 'unbin the contigs, dissolve the genome, or unlink (Backspace or Delete)'],
      [['r', 'F2'], 'rename the selected genome'],
      // Printed as every other part prints them: the contact map's close-up, the selection card, the chooser.
      [['⏎', 'shift+⏎'], 'the contigs of the selected genomes close up, and back'],
      [['/'], 'filter the list'],
      [['mod+z', 'mod+shift+z'], 'undo, redo'],
      [['0', '+', '-'], 'fit and zoom the picture under the pointer'],
    ]
    const sheet = el('div', { class: 'curate-keys', attrs: { role: 'dialog', 'aria-label': 'Keys on this stage' } })
    sheet.append(el('h3', { class: 'edit-card-head', text: 'keys on this stage' }))
    for (const [keys, words] of rows) {
      const cell = el('span', { class: 'curate-keys-keys' })
      for (const k of keys) cell.appendChild(keyBadge(k, { class: 'kbd-inline' }))
      sheet.append(el('div', { class: 'curate-keys-row' }, cell, el('span', { text: words })))
    }
    sheet.append(el('button', { class: 'btn-link', text: 'close', attrs: { type: 'button' }, on: { click: () => sheet.remove() } }))
    this.centre.appendChild(sheet)
  }

  private teardown(): void {
    if (this.closed) return
    this.closed = true
    this.network?.cancel()
    this.endDrag()
    this.chooser?.close()
    for (const off of this.offs) off()
    this.list.dispose()
    for (const pane of Object.values(this.panes)) pane.dispose()
    for (const card of this.cards) card.dispose?.()
    this.model.dispose()
    this.props.onClose()
  }
}

/** A name as a pattern that finds it literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
