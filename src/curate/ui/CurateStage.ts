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
import { sharedPrefix, shortName } from '../names'
import { newlyDuplicated, priceLines, priceOf, priceVerdict } from '../price'
import type { Suggestion } from '../suggest'
import { AUTO_THRESHOLD, LIKELY } from '../method'
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
const NOTHING_TO_ANSWER = 'Nothing to answer: the suggestions come once the contacts are read.'

/** Narrower than this, the centre shows the large picture alone, with tabs. */
const NARROW = 840
/** A held drag rests this long on a target before the pictures draw it made. */
const DROP_PREVIEW_MS = 300

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
    this.model = new CurateModel(store, { state: (curation, weights) => props.requests.state(curation, weights) }, props.debounce === undefined ? {} : { debounce: props.debounce })
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
    const tidy = el('button', {
      class: 'btn btn-quiet curate-tidy',
      text: 'tidy',
      title: 'Lay the genomes out again, the ones that meet densely side by side',
      attrs: { type: 'button' },
      on: { click: () => this.model.tidy() },
    })
    const keysButton = iconButton('keyboard', withKey('Keys on this stage', '?'), () => this.showKeys(), { class: 'btn btn-icon', size: 15 })
    const toolbar = el(
      'div',
      { class: 'curate-toolbar' },
      this.tabs,
      this.readout,
      el('div', { class: 'curate-tools' }, tidy, this.undoButton, this.redoButton, keysButton),
    )
    this.band = el('div', { class: 'curate-band hidden', attrs: { 'aria-live': 'polite' } })
    this.status = el('div', { class: 'curate-status hidden', attrs: { role: 'status' } })
    this.paneArea = el('div', { class: 'curate-panes' })
    this.centre = el('div', { class: 'curate-centre' }, toolbar, this.band, this.status, this.paneArea)

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
      auto: `Take every suggestion at ${Math.round(AUTO_THRESHOLD * 100)}% or more, the surest first, each a step to undo like any other`,
    }
    this.modes = {
      manual: this.modeButton('manual', this.modeTitles.manual),
      review: this.modeButton('review', this.modeTitles.review),
      auto: this.modeButton('auto', this.modeTitles.auto),
    }
    const modesCard = el(
      'section',
      { class: 'edit-card curate-modes-card' },
      el('h3', { class: 'edit-card-head', text: 'who presses take' }),
      el('div', { class: 'edit-modes', attrs: { role: 'group', 'aria-label': 'Who presses take' } }, this.modes.manual, this.modes.review, this.modes.auto),
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
      button.title = button.disabled ? NOTHING_TO_ANSWER : this.modeTitles[mode]
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
    const current = model.current
    if (current === null) {
      this.band.replaceChildren(el('span', { class: 'curate-band-words', text: model.stale ? 'review · weighing…' : 'review · nothing left to answer' }))
      return
    }
    const queue = model.queue()
    const question = model.currentQuestion
    const at = queue.findIndex((q) => q.key === question?.key)
    const likely = queue.filter((q) => q.confidence >= LIKELY).length
    const member = model.member
    const where =
      at < likely
        ? `review · ${at + 1} of ${fmt.int(likely)}${queue.length > likely ? ` · ${fmt.int(queue.length - likely)} less sure after` : ''}`
        : `review · less sure · ${at + 1 - likely} of ${fmt.int(queue.length - likely)}`
    const keys = el(
      'span',
      { class: 'curate-band-keys' },
      keyBadge('y', { class: 'kbd-inline' }),
      ' take ',
      keyBadge('n', { class: 'kbd-inline' }),
      ' turn down ',
      keyBadge('←', { class: 'kbd-inline' }),
      keyBadge('→', { class: 'kbd-inline' }),
      ' the others ',
      ...(question !== null && question.members.length > 1 ? [keyBadge('↓', { class: 'kbd-inline' }), keyBadge('↑', { class: 'kbd-inline' }), ' one by one '] : []),
      keyBadge(' ', { class: 'kbd-inline' }),
      ' held: as it would be',
    )
    const line = el(
      'div',
      { class: 'curate-band-line' },
      el('span', { class: 'curate-band-where', text: `${where}${member === null ? '' : ` · ${member.at + 1} of its ${member.of}`}` }),
      el('span', { class: 'curate-band-words', text: `${this.shortWords(current)} · ${displayPercent(current.confidence)}%`, title: current.words }),
      keys,
    )
    const price = el('div', { class: 'curate-band-price' })
    const before = model.answer
    const after = model.previewed
    if (before !== null && after !== null && JSON.stringify(model.previewSteps) === JSON.stringify(current.steps)) {
      const rows = priceOf(before, after).filter((row) => row.kind === 'mag')
      if (rows.length === 0) price.append(el('span', { class: 'curate-band-price-none', text: current.kind === 'link' || current.kind === 'unlink' ? 'no genome’s quality changes' : 'no marker genes to price it by' }))
      for (const row of rows.slice(0, 3)) {
        const lines = priceLines(row)
        const verdict = priceVerdict(row)
        if (lines === null) continue
        const twice = newlyDuplicated(row)
        price.append(
          el(
            'span',
            { class: `curate-band-price-row${verdict === 'demoted' ? ' is-warn' : verdict === 'promoted' ? ' is-ok' : ''}` },
            el('span', { class: 'curate-band-price-name', text: this.ctx.shortName(row.id) }),
            ` complete ${lines.completeness} · redundant ${lines.redundancy}`,
            verdict === 'demoted' ? ` · ${row.gradeAfter === 'contaminated' ? 'contaminated' : 'a grade lower'}` : verdict === 'promoted' ? ' · high quality' : '',
          ),
        )
        // What a rise in redundancy is made of, named: two organisms, or a
        // contig the genome has the like of already.
        if (twice.length > 0)
          price.append(
            el('span', {
              class: 'curate-band-price-row is-warn',
              text: `${twice.length === 1 ? 'a marker' : `${twice.length} markers`} twice: ${twice.slice(0, 4).join(', ')}${twice.length > 4 ? '…' : ''}`,
              title: twice.join(', '),
            }),
          )
      }
      // Rows with no marker gene to price them by say so, rather than nothing.
      if (price.childElementCount === 0) price.append(el('span', { class: 'curate-band-price-none', text: 'no marker genes to price it by' }))
    } else price.append(el('span', { class: 'curate-band-price-none', text: 'pricing…' }))
    this.band.replaceChildren(line, price)
  }

  /** A suggestion's words with short names. */
  private shortWords(s: Suggestion): string {
    const answer = this.model.answer
    if (answer === null) return s.words
    let words = s.words
    for (const g of s.genomes) {
      const genome = answer.genomes[g]
      if (genome === undefined) continue
      const short = this.ctx.shortName(genome.id)
      if (short !== genome.name) words = words.split(genome.name).join(short)
    }
    return words
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

  /** The readout: what a part said, the drag's words, or the curation's tally. */
  private paintReadout(): void {
    if (this.sayHeld !== null) {
      this.readout.textContent = this.sayHeld
      this.readout.classList.remove('is-summary')
      return
    }
    this.readout.classList.add('is-summary')
    const answer = this.model.answer
    if (answer === null) {
      this.readout.textContent = 'weighing…'
      return
    }
    const mags = answer.genomes.filter((genome) => genome.kind === 'mag')
    const elements = answer.genomes.length - mags.length
    let pooled = 0
    answer.genomeOf.forEach((g) => {
      if (g < 0) pooled++
    })
    const tally = this.model.tally()
    const file = this.model.fileAnswer
    const fileMags = file?.genomes.filter((genome) => genome.kind === 'mag').length ?? mags.length
    const fileElements = (file?.genomes.length ?? answer.genomes.length) - fileMags
    const was = (now: number, then: number, one: string, many: string): string => (now === then ? counted(now, one, many) : `${many} ${fmt.int(then)} → ${fmt.int(now)}`)
    const parts = [was(mags.length, fileMags, 'MAG', 'MAGs'), was(elements, fileElements, 'element', 'elements'), `${fmt.int(pooled)} unbinned`]
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
    this.centre.classList.toggle('is-narrow', this.centre.clientWidth > 0 && this.centre.clientWidth < NARROW)
    for (const pane of Object.values(this.panes)) pane.resize()
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
        if (selection.genomes.length >= 2 && selection.contigs.length === 0) {
          if (!model.mergeSelected()) this.flash('Merge MAGs with MAGs and elements with elements.')
        } else if (selection.contigs.length > 0) this.openChooser('move')
        else if (selection.genomes.length === 1) this.openChooser('merge')
        else return false
        return true
      case 'l':
      case 'L': {
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
        if (selection.contigs.length > 0) {
          const id = model.createFromSelected(kind)
          // Its name open for typing once it is counted and has a row.
          if (id !== null) this.list.startRename(id)
        } else if (selection.genomes.length > 0) model.retypeSelected(kind)
        else return false
        return true
      }
      case 'Delete':
      case 'Backspace':
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
      [[' '], 'held, in review: the binning as it would be'],
      [['m'], 'merge the selected genomes; move the selected contigs to…'],
      [['l'], 'link the selected element to the selected MAG'],
      [['b', 'e'], 'a new MAG, a new element, of the selected contigs'],
      [['delete'], 'unbin the contigs, dissolve the genome, or unlink'],
      [['r', 'F2'], 'rename the selected genome'],
      [['enter'], 'the contigs of the selected genomes, close up'],
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
