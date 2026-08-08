/**
 * One companion map: a file, a worker, a picture, and nothing else.
 *
 * The asymmetry with the lead panel is the design and not an economy. A session
 * has one file that answers *what am I looking at* — it owns the breadcrumb,
 * the genomes and contigs tables, the tracks, the record card and the
 * second-file split — and a deck of maps does not make that question have three
 * answers. So a companion carries the smallest thing that is still a map: its
 * own reader, its own colour scale, its own block, and a heading with its name
 * on it. Everything it is *of* comes from the shared view state.
 *
 * That is also what makes it cheap to state what a companion does when it
 * cannot answer. It is asked for a view by **name** — `chrI:20,000-80,000`,
 * `MAG_7`, a list of ticked sequences — and it resolves the name through its own
 * reader, so a file that has no `chrI` is refused by
 * `parse_metacooler_range`'s own error with its own list of what it does have
 * (§5.4). No gate had to be written for that case, and no gate could have
 * phrased it better.
 *
 * The one thing this file does hold that the lead does not is a **budget**:
 * every read is capped at the deck's share (`panels/deck.ts`), because N dense
 * blocks are N times a limit that was written for one (§2, §16.7).
 */

import { ViewerError } from '../errors'
import { matrixLevel, selectionOf } from '../state/ViewState'
import type { ViewState } from '../types'
import { ReaderClient } from '../worker/client'
import type { MatrixResult, OpenResult, SourceSpec } from '../worker/protocol'
import { MatrixPanel, type DerivePresentation, type TurnPresentation } from '../ui/MatrixPanel'
import { COUNT_SCORE, scoreChoices, scoreFor } from '../ui/scores'
import type { ScaleState } from '../ui/GenomeView'
import { el, fmt } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { fileLabel } from '../ui/labels'

/**
 * What block a view state asks a companion for, before any file has been
 * consulted.
 *
 * Pure, and separated from the reading so it can be stated as a table in a test:
 * this is the whole of "the view is shared", and the way it goes wrong is by
 * quietly answering a *different* view in the companion than in the lead.
 *
 * Note how few kinds there are. Almost every view of a contact map is "a block
 * named by one or two labels", and a label means the same thing in every file
 * that has it — which is precisely why the selection can be shared across files
 * of different bin size when the *bins* could not be.
 */
export type BlockPlan =
  | { kind: 'names'; rows: string; cols?: string }
  | { kind: 'whole' }
  | { kind: 'selection'; unit: 'genome' | 'contig'; names: string[] }
  | { kind: 'none'; reason: string }

/** The block `state` asks for, in the vocabulary a companion can act on. */
export function planFor(state: ViewState): BlockPlan {
  switch (state.view) {
    case 'region':
      return state.region === undefined
        ? { kind: 'none', reason: 'no region named' }
        : {
            kind: 'names',
            rows: state.region,
            ...(state.region2 === undefined ? {} : { cols: state.region2 }),
          }
    case 'genome':
      return state.genome === undefined
        ? { kind: 'none', reason: 'no genome named' }
        : { kind: 'names', rows: state.genome }
    case 'pair':
      return state.genome === undefined || state.genome2 === undefined
        ? { kind: 'none', reason: 'no pair named' }
        : { kind: 'names', rows: state.genome, cols: state.genome2 }
    case 'whole':
      return { kind: 'whole' }
    case 'selection': {
      const selection = selectionOf(state)
      return selection === null
        ? { kind: 'none', reason: 'nothing selected' }
        : { kind: 'selection', unit: selection.kind, names: selection.names }
    }
    default:
      // The tables, the whole-metagenome scan and the 1D browser. Each is a
      // picture of a *file* rather than of a place in one, so there is nothing
      // for a second file to show beside it — a genomes table of another file
      // is not the same genomes table, it is another file's.
      return {
        kind: 'none',
        reason: 'this view is of one file — pick a region, a genome or a selection',
      }
  }
}

export interface MapPanelProps {
  /** The URI as requested, which is what the hash carries. */
  uri: string
  source: SourceSpec
  /**
   * What this panel may spend on one block, now.
   *
   * A function, not a number: the share shrinks as maps are added and the panel
   * outlives the addition. See {@link panelBudgetBytes}.
   */
  budgetBytes(): number
  /** The panel finished a read, or failed one; the deck relocks and repaints. */
  onSettled(): void
  /** The × on this panel's heading. */
  onClose(): void
  /** The chain on this panel's heading — follow the deck, or go it alone. */
  onToggleLock(): void
  /** Whether the reader has asked for this panel to follow the deck. */
  isLocked(): boolean
  /**
   * Why it is not following anyway, or `null` when it is.
   *
   * Asking is not the same as being followed: a block that spans a different
   * stretch of genome cannot honestly share a window, and the deck refuses
   * rather than drawing one file's coordinate under another's. A chain that
   * looked closed while the lock skipped the panel would be the one way a
   * navigation lock can be quietly wrong.
   */
  lockNote(): string | null
  /**
   * The colour scale this panel opens at, read once when its map is built.
   *
   * The lead's transform and colormap, always — a deck whose panels are drawn
   * with different ramps is one where the eye has to translate before it can
   * compare, which is the whole thing a deck is for. The lead's *clip* only
   * where the reader has asked for one scale (§16.2), because a clip is a
   * number of contacts and two depths do not share one.
   */
  initialLook(): ScaleState
  /**
   * The derivation the deck is showing, as a thunk so it is never stale.
   *
   * Shared, like the score and the level and for the same reason: a deck exists
   * to put N files' pictures of one place side by side, and one panel drawing
   * O/E beside four drawing raw counts is four wrong comparisons rather than a
   * choice. No handler on it, so a companion applies it and offers no control
   * over it (`ui/MatrixPanel.ts`'s `DerivePresentation`).
   */
  derive(): DerivePresentation | undefined
  /**
   * Whether the deck is turned 45°, as a thunk so it is never stale.
   *
   * Shared for the same reason the derivation is, and more visibly: a flip
   * changes the *shape* of the picture, so a deck whose lead is a triangular
   * band beside four squares is not four maps of one place with one of them
   * emphasised — it is a bar that says "one navigation" over five pictures that
   * are no longer in the same coordinates. Carries no `onChange`, which is what
   * makes a companion apply the turn without offering a sixth copy of the
   * control, and no `onAvailable`, because whether *this* file's block has a
   * diagonal is not a reason to un-turn the deck (`ui/MatrixPanel.ts`).
   */
  turn(): TurnPresentation | undefined
  /** Move this panel one place along the deck; absent at either end. */
  onMove(delta: number): void
}

export class MapPanel {
  readonly el: HTMLElement
  /**
   * The map, once there is a file behind it.
   *
   * Built at the first successful read rather than at construction, because a
   * `MatrixPanel` with no block is a grey rectangle with a colourbar on it, and
   * a deck of five of those while five files open is worse than five headings
   * that say what they are doing.
   */
  private panel: MatrixPanel | null = null
  private readonly client = new ReaderClient()
  private readonly body = el('div', { class: 'deck-body' })
  private readonly note = el('p', { class: 'deck-note' })
  /** Kept apart from {@link note}: one is about the read, the other the lock. */
  private readonly lockNoteEl = el('p', { class: 'deck-note deck-unlocked hidden' })
  private refusal: string | null = null
  private readonly nameEl: HTMLElement
  private readonly lockButton: HTMLElement
  private opening: Promise<OpenResult> | null = null
  private disposed = false
  /**
   * The state the last read was issued for.
   *
   * A deck is reconciled on every render, and most renders change nothing about
   * the block — a colour nudge, a tab switch, another panel finishing. Without
   * this each of them re-reads every companion.
   */
  private read: string | null = null
  /** Colour scale, per panel; see {@link applyLook}. */
  private look: ScaleState = {}

  constructor(private readonly props: MapPanelProps) {
    this.nameEl = el('span', {
      class: 'deck-name',
      text: fileLabel(props.uri),
      title: props.uri,
    })
    this.lockButton = iconButton(
      'link',
      'Following the other maps. Click to move this one on its own.',
      () => props.onToggleLock(),
      { class: 'btn btn-icon deck-lock', size: 14 },
    )
    this.el = el(
      'section',
      { class: 'deck-panel' },
      el(
        'header',
        { class: 'deck-head' },
        this.nameEl,
        this.lockButton,
        iconButton('chevron-left', 'Move this map one place earlier', () => props.onMove(-1), {
          class: 'btn btn-icon deck-move',
          size: 14,
        }),
        iconButton('chevron-right', 'Move this map one place later', () => props.onMove(1), {
          class: 'btn btn-icon deck-move',
          size: 14,
        }),
        iconButton('x', `Close ${fileLabel(props.uri)}`, () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.note,
      this.lockNoteEl,
      this.body,
    )
    this.say('opening…')
  }

  get uri(): string {
    return this.props.uri
  }

  /** The map, for the deck's lock; `null` until this panel has read a block. */
  get map(): MatrixPanel | null {
    return this.panel
  }

  syncLock(): void {
    const wanted = this.props.isLocked()
    const refusal = this.props.lockNote()
    const following = wanted && refusal === null
    this.lockButton.replaceChildren(icon(following ? 'link' : 'unlink', { size: 14 }))
    this.lockButton.title = following
      ? 'Following the other maps. Click to move this one on its own.'
      : wanted
        ? (refusal ?? 'Not following the other maps.')
        : 'Moving on its own. Click to bring it back in step with the others.'
    this.lockButton.setAttribute('aria-pressed', String(following))
    this.lockButton.setAttribute('aria-label', this.lockButton.title)
    this.el.classList.toggle('is-unlocked', !following)
    // The refusal is a sentence and belongs where a reader looking at the still
    // map will find it, not only in a tooltip on a 14 px icon. Only when the
    // reader *asked* for the lock: a panel deliberately let off the lead needs
    // no explanation, and one printed under it would read as a fault.
    this.refusal = wanted ? refusal : null
    this.sayRefusal()
  }

  /**
   * Adopt the shared view.
   *
   * Everything a companion is *of* arrives here, and nothing it looks like
   * does: the colour scale is {@link applyLook}'s, and the two are separate
   * because they answer to different owners (§16.2).
   */
  apply(state: ViewState): void {
    // The derivation and the turn first, and separately from the read: both are
    // transforms over cells that are already here, so `keyFor` deliberately
    // carries neither and a change to either would otherwise short-circuit
    // against an unchanged key — leaving this companion drawing counts beside a
    // lead drawing a ratio, or square beside a lead on its diagonal.
    this.panel?.rederive(this.props.derive(), undefined, this.props.turn())
    void this.load(state)
  }

  /**
   * Adopt a colour scale from outside — the deck's "one scale for all".
   *
   * Off by default, and the default is the argument: `vmax` is a number of
   * contacts, and two libraries sequenced to different depths do not have the
   * same one. Sharing a *transform* and a *colormap* is a claim about the
   * picture; sharing a clip is a claim about the numbers, and only the reader
   * knows whether these files support it.
   */
  applyLook(look: ScaleState): void {
    this.look = look
    this.panel?.applyScale(look)
  }

  remeasure(): void {
    this.panel?.remeasure()
  }

  destroy(): void {
    this.disposed = true
    this.panel?.destroy()
    this.panel = null
    this.client.terminate()
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async open(): Promise<OpenResult> {
    this.opening ??= this.client.request<'open'>({
      kind: 'open',
      uri: this.props.uri,
      source: this.props.source,
    })
    return this.opening
  }

  private async load(state: ViewState): Promise<void> {
    const plan = planFor(state)
    if (plan.kind === 'none') {
      this.read = null
      this.body.replaceChildren()
      this.panel?.destroy()
      this.panel = null
      this.say(plan.reason)
      this.props.onSettled()
      return
    }

    try {
      const info = await this.open()
      if (this.disposed) return
      const key = this.keyFor(state, plan, info)
      if (key === this.read) return
      this.read = key
      this.panel?.setBusy(true)
      this.say('')
      const result = await this.readBlock(state, plan, info)
      if (this.disposed || this.read !== key) return
      this.show(result, info, state)
      this.props.onSettled()
    } catch (err) {
      if (this.disposed) return
      // The key is *kept*. Every refusal a companion meets is deterministic — a
      // name this file has not got, a block this share of the budget will not
      // lend — so clearing it would re-issue the same refused read on every
      // repaint, which for a colour slider is one per nudge. Changing the region
      // changes the key, which is what retries.
      this.panel?.setBusy(false)
      // A companion never replaces the page with an error screen. The lead's
      // map is a complete picture on its own and the reader is looking at it;
      // what a companion owes them is one sentence in its own frame saying why
      // its rectangle is empty. That covers the two failures that are actually
      // common — a name this file does not have (§5.4) and a block this share
      // of the budget will not lend (§16.7) — and it keeps the deck usable
      // while one of its files is wrong.
      this.say(err instanceof ViewerError || err instanceof Error ? err.message : String(err))
      this.props.onSettled()
    }
  }

  /**
   * What was read, as a string — the cache key of {@link read}.
   *
   * Everything that changes the *block*, and nothing that changes its colour.
   * A key that carried the transform would re-read the file on every nudge of
   * the clip; one that omitted the level would keep a bin-level block on screen
   * under a contig-level axis.
   */
  private keyFor(state: ViewState, plan: Exclude<BlockPlan, { kind: 'none' }>, info: OpenResult): string {
    const choice = scoreFor(scoreChoices({ hasWeights: info.hasWeights, scoreColumns: info.scoreColumns }), state)
    return JSON.stringify([plan, matrixLevel(state), choice.id])
  }

  private async readBlock(
    state: ViewState,
    plan: Exclude<BlockPlan, { kind: 'none' }>,
    info: OpenResult,
  ): Promise<MatrixResult> {
    const choices = scoreChoices({ hasWeights: info.hasWeights, scoreColumns: info.scoreColumns })
    const choice = scoreFor(choices, state)
    const level = matrixLevel(state)
    // Resolved against *this* file's columns rather than carried over from the
    // lead: a hash naming `expected` is naming a column, and the file beside it
    // may not have one. Falling back to counts is the same rule `scoreFor`
    // applies to a hash naming a column the lead does not have.
    const value = choice.value === undefined || choice.value === COUNT_SCORE ? {} : { value: choice.value }
    const balance = choice.balance ? { balance: true } : {}
    const budgetBytes = this.props.budgetBytes()

    if (plan.kind === 'selection') {
      return this.client.request<'selection'>({
        kind: 'selection',
        unit: plan.unit,
        names: plan.names,
        budgetBytes,
        ...balance,
        ...value,
      })
    }

    const rows: [number, number] =
      plan.kind === 'whole'
        ? info.displayExtent
        : (await this.client.request<'range'>({ kind: 'range', range: plan.rows })).extent
    const cols =
      plan.kind === 'names' && plan.cols !== undefined
        ? {
            cols: (await this.client.request<'range'>({ kind: 'range', range: plan.cols })).extent,
          }
        : {}

    if (level === 'contig') {
      return this.client.request<'aggregate'>({
        kind: 'aggregate',
        rows,
        ...cols,
        level: 'contig',
        ...balance,
        ...value,
        budgetBytes,
      })
    }
    return this.client.request<'matrix'>({
      kind: 'matrix',
      rows,
      ...cols,
      ...balance,
      ...value,
      budgetBytes,
    })
  }

  /**
   * Put a block on screen, building the map the first time.
   *
   * The panel is built with **no** annotations, no compare, no level toggle and
   * no score picker. Not an oversight: each of those is a control over
   * something the deck shares, and offering five copies of a shared control is
   * five ways for a reader to put the deck out of step with itself. The one
   * control a companion keeps is its colour scale, because that is the one
   * thing §16.2 makes per panel.
   */
  private show(result: MatrixResult, info: OpenResult, state: ViewState): void {
    // Recorded before `setData` reads it and on every block, because a panel
    // outlives the derivation it was constructed with: the reader may have
    // turned O/E on, or flipped the deck, while this companion was fetching.
    // Recorded rather than applied — `rederive` would rebuild the picture from
    // the block that is about to be replaced.
    this.panel?.setDerive(this.props.derive())
    this.panel?.setTurn(this.props.turn())
    if (this.panel === null) {
      // Read once, here, rather than held from construction: a companion is
      // built before its file has been opened and the lead may have been
      // recoloured in between.
      this.look = { ...this.props.initialLook(), ...this.look }
      const turn = this.props.turn()
      this.panel = new MatrixPanel({
        binsize: info.binsize ?? 1,
        initial: this.look,
        ...(this.props.derive() === undefined ? {} : { derive: this.props.derive() }),
        ...(turn === undefined ? {} : { turn }),
        detachedControls: true,
        hideTitle: true,
        caption: { file: fileLabel(this.props.uri) },
        // The clip a companion arrives at is its own — see {@link applyLook}.
        onScaleChange: (scale) => {
          this.look = scale
        },
      })
      // Colour and export, folded, under the picture they belong to. Not the
      // Tracks card and not Groups: both are about annotations, a companion
      // carries none, and a card offering to size lanes that cannot exist is
      // worse than no card. Export *is* offered, because a panel of a deck is
      // exactly the thing somebody wants as a figure on its own.
      this.body.replaceChildren(
        this.panel.el,
        el(
          'details',
          { class: 'deck-look' },
          el('summary', { text: 'colour and export' }),
          this.panel.controlsEl,
          this.panel.exportEl,
        ),
      )
    }
    this.say('')
    this.panel.setResolution((info.binsize ?? 1) * (result.binsPerCell ?? 1))
    this.panel.setData(result, fileLabel(this.props.uri))
    this.nameEl.title =
      `${this.props.uri} — ${fmt.int(info.binsize ?? 0)} bp bins, ` +
      `${fmt.int(result.nrows)}×${fmt.int(result.ncols)} cells` +
      (state.view === 'whole' ? ' (whole file)' : '')
  }

  /** One line under the heading, or none. */
  private say(message: string): void {
    this.note.textContent = message
    this.note.classList.toggle('hidden', message === '')
  }

  private sayRefusal(): void {
    this.lockNoteEl.textContent = this.refusal ?? ''
    this.lockNoteEl.classList.toggle('hidden', this.refusal === null)
  }
}

/** Why a cell of the deck is empty — see {@link VacantPanel}. */
export type VacancyOrigin = 'drawn' | 'link'

/**
 * Where a link left an empty cell, or where a reader drew one.
 *
 * Its own small class rather than a state of {@link MapPanel}, because it has
 * no worker, no reader and nothing to read: it is a sentence and a drop target.
 * Keeping the two apart is what stops "a panel with no file" from becoming a
 * branch in every method above.
 */
export class VacantPanel {
  readonly el: HTMLElement

  constructor(props: {
    /**
     * Whether this cell was **drawn** by the reader looking at it, or arrived
     * in a link.
     *
     * Only the words change, and they have to: the two are the same cell to
     * every line of code that touches it — the same `~` in the hash, the same
     * drop target, the same slot in the grid — but they are not the same fact
     * about the deck. One is a space somebody left for a file they are about to
     * choose; the other is a position that *had* a map in it, which no page can
     * re-open by name (§11), and telling a reader that a map "was here" when
     * they drew the empty cell themselves ten seconds ago is a small lie about
     * their own deck. The distinction lives only in this session: a reload
     * cannot tell them apart, which is why the link's wording covers both.
     */
    origin: VacancyOrigin
    onOpen(file: File): void
    onClose(): void
    onMove(delta: number): void
  }) {
    const drawn = props.origin === 'drawn'
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file !== undefined) props.onOpen(file)
    })
    const zone = el(
      'div',
      { class: 'ann-drop deck-drop deck-vacant', attrs: { tabindex: '0', role: 'button' } },
      el('span', {
        class: 'ann-drop-label',
        text: drawn ? 'Drop a map here' : 'A map was here',
      }),
      el('span', {
        class: 'ann-drop-hint',
        text: drawn
          ? 'An empty cell of the deck you drew. Drop a cooler on it, or click to choose one, and ' +
            'it opens in this position under the same navigation as the maps beside it — same ' +
            'region, same level, its own colour scale. Leaving it empty is fine; the link keeps it.'
          : 'The link that opened this deck has a cell here with no file a page can fetch by name ' +
            '(§11) — either a local map the sender had open, or a cell they left empty on ' +
            'purpose. Drop a file here, or click to choose one, and the panel fills in where it ' +
            'was; the maps either side keep their order.',
      }),
      input,
    )
    zone.addEventListener('click', (event) => {
      if (event.target !== input) input.click()
    })
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') input.click()
    })
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      const file = event.dataTransfer?.files?.[0]
      if (file !== undefined) props.onOpen(file)
    })

    this.el = el(
      'section',
      { class: 'deck-panel is-vacant' },
      el(
        'header',
        { class: 'deck-head' },
        el('span', { class: 'deck-name deck-name-vacant', text: 'empty' }),
        iconButton('chevron-left', 'Move this cell one place earlier', () => props.onMove(-1), {
          class: 'btn btn-icon deck-move',
          size: 14,
        }),
        iconButton('chevron-right', 'Move this cell one place later', () => props.onMove(1), {
          class: 'btn btn-icon deck-move',
          size: 14,
        }),
        iconButton('x', 'Close this cell — the deck loses a place', () => props.onClose(), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      zone,
    )
  }

  /** Nothing to release: a vacancy holds no worker and no bytes. */
  destroy(): void {}
}
