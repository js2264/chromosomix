/**
 * The curation stage's controller (SPECS §33.3): everything the stage knows and
 * does but draw — the method's answer for the binning as it stands, counted
 * again after every step; the order the genomes are laid out in, kept across
 * steps; what is selected and what is under the pointer; the suggestions on
 * offer, the one in review, the answers and what they teach; and the steps the
 * stage's acts make.
 *
 * Every step goes through the {@link CurationStore}, so the session hears of it
 * from one place; every count goes through a {@link CurateClient}, the worker in
 * the app and the method itself in the tests. An answer is taken only if it is
 * the answer to the last count asked, so a slow answer never paints over a
 * later step.
 */

import { UNBINNED_WORDS, withCurationStep, type Curation, type CurationStep, type GenomeKind } from '../genome/curation'
import type { CurationLearned, CurationStore, LearnedKind } from '../state/curation'
import type { CurationStateResult } from '../worker/curateProtocol'
import { AUTO_THRESHOLD, INITIAL_WEIGHTS, learn, LIKELY, OFFER_FLOOR } from './method'
import { dropPlan, type DropPlan } from './drop'
import { chainOrder, elementOrder, keepOrder } from './order'
import { questions, type Question } from './questions'
import { priceOf, priceVerdict } from './price'
import type { KindWeights, Suggestion } from './suggest'
import type { CurateDragged, CurateDropTarget } from './ui/context'

/** A request that can be called off: the reader's `cancellable`. */
export interface Cancellable<T> {
  promise: Promise<T>
  cancel(): void
}

/** How the stage counts: the worker in the app, the method in the tests. */
export interface CurateClient {
  state(curation: Curation | null, weights: KindWeights): Cancellable<CurationStateResult>
}

/** Who presses accept: the reader alone, the reader one suggestion at a time, or the stage for the sure ones. */
export type CurateMode = 'manual' | 'review' | 'auto'

/** What changed, for the stage to repaint only that. */
export type CurateChange = 'state' | 'counting' | 'selection' | 'hover' | 'mode' | 'current' | 'error' | 'preview'

/** What is selected: whole genomes by id, and contigs by index of the file's. */
export interface CurateSelection {
  genomes: readonly string[]
  contigs: readonly number[]
}

/** How a click adds to the selection. */
export type SelectHow = 'replace' | 'add' | 'toggle'

/** The most steps one press of auto makes. */
export const AUTO_MOST = 200

/** The prefix of the ids the stage mints for a genome a step creates. */
const MINTED = 'curated:'
/** A minted id inside a step's id or a suggestion's key. */
const MINTED_ID = /curated:(\d+)/g

export interface CurateModelOptions {
  /** How long after a step the count is asked, in ms: steps in a burst are counted once. */
  debounce?: number
  /** A timer, for tests: returns its own cancel. */
  schedule?: (run: () => void, ms: number) => () => void
}

/** Every step's word of what changed since the file, for the stage's running tally. */
export interface CurateTally {
  steps: number
  /** Contigs whose genome is not the file's. */
  contigsMoved: number
  basesMoved: number
  /** Genomes as in the file, changed, new, and gone. */
  asInFile: number
  changed: number
  created: number
  gone: number
  /** Links the file did not hold, and links of the file now gone. */
  linksAdded: number
  linksDropped: number
}

export class CurateModel {
  private answerHeld: CurationStateResult | null = null
  private ticket = 0
  private pending: Cancellable<CurationStateResult> | null = null
  private cancelTimer: (() => void) | null = null
  private staleHeld = true
  private errorHeld: string | null = null
  private orderHeld: string[] = []
  /** The genome each contig was in at the last answer, by id: where a new genome came from. */
  private previousOwner: Array<string | null> = []
  private previousKind = new Map<string, GenomeKind>()
  private selectionHeld: CurateSelection = { genomes: [], contigs: [] }
  private hoverGenome: string | null = null
  private hoverContig = -1
  private modeHeld: CurateMode = 'manual'
  private currentKey: string | null = null
  /**
   * Inside the current question: the member answered alone, by key, or `null`
   * for the whole — by key, so a question regrouped by a count keeps it, and one
   * that left the queue does not hand it to another.
   */
  private memberKey: string | null = null
  private queueHeld: { answer: CurationStateResult; rejected: string; list: Question[] } | null = null
  private autoRun: { stopped: boolean } | null = null
  private waiters: Array<() => void> = []
  private previewHeld: { key: string; steps: readonly CurationStep[]; answer: CurationStateResult | null } | null = null
  /** Whether the pictures draw the preview (Space held), or it is only priced. */
  private previewDrawn = false
  private fileHeld: CurationStateResult | null = null
  /** Whether the order was laid out on an answer that read the contacts. */
  private laidOut = false
  private contigNames: Set<string> | null = null
  private previewTicket = 0
  private previewRequest: Cancellable<CurationStateResult> | null = null
  private readonly listeners = new Set<(change: CurateChange) => void>()
  private readonly unsubscribe: () => void
  private readonly debounce: number
  private readonly schedule: (run: () => void, ms: number) => () => void
  private disposed = false

  constructor(
    private readonly store: CurationStore,
    private readonly client: CurateClient,
    options: CurateModelOptions = {},
  ) {
    this.debounce = options.debounce ?? 30
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      })
    this.unsubscribe = store.subscribe(() => {
      // A preview is of one more step on the binning as it was: gone with it.
      this.clearPreview()
      this.recount()
    })
    this.recount(0)
  }

  // -------------------------------------------------------------------------
  // Listening.
  // -------------------------------------------------------------------------

  subscribe(listener: (change: CurateChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: CurateChange): void {
    for (const listener of this.listeners) listener(change)
  }

  /** Stop listening and counting; an auto run in progress stops. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.pending?.cancel()
    this.pending = null
    this.previewRequest?.cancel()
    this.previewRequest = null
    this.cancelTimer?.()
    this.cancelTimer = null
    if (this.autoRun !== null) this.autoRun.stopped = true
    this.release()
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // Counting.
  // -------------------------------------------------------------------------

  /** The method's answer for the binning as it stands; the last one while a count runs. */
  get answer(): CurationStateResult | null {
    return this.answerHeld
  }

  /** Whether a step has been made since the answer: the stage says it is weighing. */
  get stale(): boolean {
    return this.staleHeld
  }

  /** Why the last count failed, or `null`. */
  get error(): string | null {
    return this.errorHeld
  }

  /** The weights the suggestions are counted with: what the review taught, else the initial ones. */
  get weights(): KindWeights {
    return { ...this.store.learned.weights }
  }

  /** Count again: after a step, an answer, or an undo. */
  recount(delay = this.debounce): void {
    if (this.disposed) return
    const ticket = ++this.ticket
    this.pending?.cancel()
    this.pending = null
    this.cancelTimer?.()
    const wasStale = this.staleHeld
    this.staleHeld = true
    if (!wasStale) this.emit('counting')
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      if (ticket !== this.ticket || this.disposed) return
      const request = this.client.state(this.store.curation, this.weights)
      this.pending = request
      request.promise.then(
        (answer) => {
          if (ticket !== this.ticket || this.disposed) return
          this.pending = null
          this.take(answer)
        },
        (error: unknown) => {
          if (ticket !== this.ticket || this.disposed) return
          this.pending = null
          this.staleHeld = false
          this.errorHeld = error instanceof Error ? error.message : String(error)
          if (this.autoRun !== null) this.autoRun.stopped = true
          this.release()
          this.emit('error')
        },
      )
    }, delay)
  }

  /** A promise kept once the answer is the binning's as it stands. */
  settled(): Promise<void> {
    if (!this.staleHeld) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(): void {
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) resolve()
  }

  private countingFile = false

  /** Count the file's own binning once, for what a genome was before the curation. */
  private countFile(): void {
    if (this.countingFile) return
    this.countingFile = true
    this.client.state(null, this.weights).promise.then(
      (answer) => {
        this.countingFile = false
        if (this.disposed || (this.fileHeld?.counted === true && !answer.counted)) return
        this.fileHeld = answer
        this.emit('state')
      },
      () => {
        this.countingFile = false
      },
    )
  }

  private take(answer: CurationStateResult): void {
    const first = this.answerHeld === null
    this.answerHeld = answer
    if (this.store.applied === 0 && answer.counted) this.fileHeld = answer
    else if (this.fileHeld === null || !this.fileHeld.counted) this.countFile()
    this.staleHeld = false
    this.errorHeld = null
    // The order is laid out on the first answer, and again on the first that
    // read the contacts; kept across steps from then on.
    if (first || (answer.counted && !this.laidOut)) this.orderHeld = this.freshOrder(answer)
    else this.orderHeld = this.keptOrder(answer)
    if (answer.counted) this.laidOut = true
    this.previousOwner = Array.from(answer.genomeOf, (g) => (g < 0 ? null : answer.genomes[g].id))
    this.previousKind = new Map(answer.genomes.map((genome) => [genome.id, genome.kind]))
    this.pruneSelection(answer)
    this.release()
    this.emit('state')
  }

  // -------------------------------------------------------------------------
  // As it would be.
  // -------------------------------------------------------------------------

  /**
   * Count the binning as it would be with one more step, or a question's
   * steps together — the review's Space held, a suggestion hovered, a drop
   * about to be made — as a step is counted, kept by the steps (asking the
   * same twice counts once) and dropped by any step made. `null` lets go of
   * it.
   */
  preview(what: CurationStep | readonly CurationStep[] | null, draw = true): void {
    const steps = what === null ? [] : isStepList(what) ? what : [what]
    if (steps.length === 0) {
      this.clearPreview()
      return
    }
    const key = JSON.stringify(steps.length === 1 ? steps[0] : steps)
    if (this.previewHeld?.key === key) {
      this.drawPreview(draw)
      return
    }
    this.previewDrawn = draw
    this.previewRequest?.cancel()
    const ticket = ++this.previewTicket
    this.previewHeld = { key, steps, answer: null }
    const request = this.client.state(withSteps(this.store.curation, steps, 'reader'), this.weights)
    this.previewRequest = request
    request.promise.then(
      (answer) => {
        if (ticket !== this.previewTicket || this.disposed || this.previewHeld?.key !== key) return
        this.previewRequest = null
        this.previewHeld = { key, steps, answer }
        this.emit('preview')
      },
      () => {
        if (ticket === this.previewTicket) this.previewRequest = null
      },
    )
    this.emit('preview')
  }

  /** The step previewed, counted or not, where it is one step; `null` with none, or several ({@link previewSteps}). */
  get previewStep(): CurationStep | null {
    const steps = this.previewHeld?.steps
    return steps?.length === 1 ? steps[0] : null
  }

  /** The steps previewed, counted or not: one, or a question's every step. */
  get previewSteps(): readonly CurationStep[] | null {
    return this.previewHeld?.steps ?? null
  }

  /** The binning as it would be, once counted; `null` while counting or with no preview. */
  get previewed(): CurationStateResult | null {
    return this.previewHeld?.answer ?? null
  }

  /** What the pictures draw: the binning as it would be while a preview is drawn and counted, else as it is. */
  get shown(): CurationStateResult | null {
    return (this.previewDrawn ? this.previewHeld?.answer : null) ?? this.answerHeld
  }

  /** Draw the preview held, or only price it: Space held and let go in review. */
  drawPreview(on: boolean): void {
    if (on === this.previewDrawn) return
    this.previewDrawn = on
    if (this.previewHeld?.answer !== null && this.previewHeld !== null) this.emit('preview')
  }

  /** Whether the pictures draw a preview now. */
  get previewing(): boolean {
    return this.previewDrawn && this.previewHeld?.answer !== null && this.previewHeld !== null
  }

  /**
   * The file's own binning, counted: what a genome was before the curation —
   * the first answer where nothing is applied, else counted once on its own.
   */
  get fileAnswer(): CurationStateResult | null {
    return this.fileHeld
  }

  private clearPreview(): void {
    if (this.previewHeld === null && this.previewRequest === null) return
    this.previewTicket++
    this.previewRequest?.cancel()
    this.previewRequest = null
    this.previewHeld = null
    this.previewDrawn = false
    if (!this.disposed) this.emit('preview')
  }

  // -------------------------------------------------------------------------
  // The order.
  // -------------------------------------------------------------------------

  /** The genomes' ids in the order the stage lays them out: MAGs, then elements. */
  get order(): readonly string[] {
    return this.orderHeld
  }

  /** The order as indices of the answer's genomes. */
  orderIndices(): number[] {
    const answer = this.answerHeld
    if (answer === null) return []
    const index = new Map(answer.genomes.map((genome, g) => [genome.id, g]))
    return this.orderHeld.map((id) => index.get(id)).filter((g): g is number => g !== undefined)
  }

  /**
   * Lay the genomes out again, densest pairs side by side (`curate/order.ts`):
   * asked for — never after a step, so nothing moves under the hand.
   */
  tidy(): void {
    if (this.answerHeld === null) return
    this.orderHeld = this.chainedOrder(this.answerHeld)
    this.emit('state')
  }

  /**
   * The order the stage opens on: the MAGs chained so the genomes that meet
   * densely are neighbours, each element beside the MAG it meets most
   * (`curate/order.ts`) — on MM133 the five organisms the binner left in
   * pieces each one block, where the file's order joins one. Before the
   * contacts are read, the file's: MAGs, then elements.
   */
  private freshOrder(answer: CurationStateResult): string[] {
    return answer.counted ? this.chainedOrder(answer) : answer.genomes.map((genome) => genome.id)
  }

  private chainedOrder(answer: CurationStateResult): string[] {
    const size = (g: number): number => answer.genomes[g].length
    const mags: number[] = []
    const elements: number[] = []
    answer.genomes.forEach((genome, g) => (genome.kind === 'mag' ? mags : elements).push(g))
    const magOrder = chainOrder(mags, answer.pairs, size)
    const elementsOrder = elementOrder(elements, magOrder, answer.pairs, size)
    return [...magOrder, ...elementsOrder].map((g) => answer.genomes[g].id)
  }

  private keptOrder(answer: CurationStateResult): string[] {
    // A genome whose kind changed goes to its new kind's block, as new.
    const before = this.orderHeld.filter((id) => {
      const genome = answer.genomes.find((g) => g.id === id)
      return genome === undefined || this.previousKind.get(id) === genome.kind
    })
    const from = new Map<string, string[]>()
    answer.genomeOf.forEach((g, c) => {
      if (g < 0) return
      const id = answer.genomes[g].id
      const was = this.previousOwner[c] ?? null
      if (was === null || was === id) return
      const list = from.get(id)
      if (list === undefined) from.set(id, [was])
      else if (!list.includes(was)) list.push(was)
    })
    const kept = keepOrder(
      before,
      answer.genomes.map((genome) => ({ id: genome.id, kind: genome.kind, from: from.get(genome.id) ?? [] })),
    )
    // MAGs stay ahead of the elements, whatever a source's place.
    const kind = new Map(answer.genomes.map((genome) => [genome.id, genome.kind]))
    return [...kept.filter((id) => kind.get(id) === 'mag'), ...kept.filter((id) => kind.get(id) === 'element')]
  }

  // -------------------------------------------------------------------------
  // Selection and hover.
  // -------------------------------------------------------------------------

  get selection(): CurateSelection {
    return this.selectionHeld
  }

  /** Select genomes by id. */
  selectGenomes(ids: Iterable<string>, how: SelectHow = 'replace'): void {
    this.setSelection({ genomes: combine(this.selectionHeld.genomes, [...ids], how), contigs: how === 'replace' ? [] : this.selectionHeld.contigs })
  }

  /** Select contigs by index of the file's. */
  selectContigs(contigs: Iterable<number>, how: SelectHow = 'replace'): void {
    const next = combine(this.selectionHeld.contigs, [...contigs], how).sort((a, b) => a - b)
    this.setSelection({ genomes: how === 'replace' ? [] : this.selectionHeld.genomes, contigs: next })
  }

  /** Select exactly these genomes and contigs. */
  select(selection: CurateSelection): void {
    this.setSelection({ genomes: [...new Set(selection.genomes)], contigs: [...new Set(selection.contigs)].sort((a, b) => a - b) })
  }

  clearSelection(): void {
    this.setSelection({ genomes: [], contigs: [] })
  }

  private setSelection(next: CurateSelection): void {
    const now = this.selectionHeld
    if (sameList(now.genomes, next.genomes) && sameList(now.contigs, next.contigs)) return
    this.selectionHeld = next
    this.emit('selection')
  }

  /** Drop from the selection what no longer exists. */
  private pruneSelection(answer: CurationStateResult): void {
    const ids = new Set(answer.genomes.map((genome) => genome.id))
    const genomes = this.selectionHeld.genomes.filter((id) => ids.has(id))
    if (genomes.length !== this.selectionHeld.genomes.length) this.selectionHeld = { genomes, contigs: this.selectionHeld.contigs }
  }

  /** What is under the pointer: a genome by id, a contig by index, or nothing. */
  hover(genome: string | null, contig = -1): void {
    if (genome === this.hoverGenome && contig === this.hoverContig) return
    this.hoverGenome = genome
    this.hoverContig = contig
    this.emit('hover')
  }

  get hovered(): { genome: string | null; contig: number } {
    return { genome: this.hoverGenome, contig: this.hoverContig }
  }

  // -------------------------------------------------------------------------
  // Suggestions.
  // -------------------------------------------------------------------------

  get mode(): CurateMode {
    return this.modeHeld
  }

  setMode(mode: CurateMode): void {
    if (mode === this.modeHeld) return
    const leaving = this.modeHeld === 'review'
    this.modeHeld = mode
    if (mode !== 'auto' && this.autoRun !== null) this.autoRun.stopped = true
    this.currentKey = mode === 'review' ? (this.queue()[0]?.key ?? null) : null
    this.memberKey = null
    // The review priced its question with a preview nobody else asked for.
    if (leaving) this.clearPreview()
    this.emit('mode')
  }

  /**
   * The suggestions on offer — at {@link OFFER_FLOOR} or more and not turned
   * down — in the order a curator answers them: the likely ones first, and
   * among them the merges, then the moves, the recruits and the host links,
   * since a merge changes every affinity of the genome it makes (on MM133 one
   * merge answers eighteen moves between three fragments); the surest first
   * within a kind.
   */
  offered(): Suggestion[] {
    const answer = this.answerHeld
    if (answer === null) return []
    const rejected = new Set(this.store.learned.rejected)
    return answer.suggestions.filter((s) => s.confidence >= OFFER_FLOOR && !rejected.has(s.key)).sort(queueOrder)
  }

  /** The suggestions on offer at {@link LIKELY} or more. */
  likely(): Suggestion[] {
    return this.offered().filter((s) => s.confidence >= LIKELY)
  }

  /** The suggestions auto would take: at {@link AUTO_THRESHOLD} or more. */
  sure(): Suggestion[] {
    return this.offered().filter((s) => s.confidence >= AUTO_THRESHOLD)
  }

  /** The keys turned down, with the suggestion where it is still made. */
  declined(): Array<{ key: string; suggestion: Suggestion | null }> {
    const answer = this.answerHeld
    const byKey = new Map((answer?.suggestions ?? []).map((s) => [s.key, s]))
    return this.store.learned.rejected.map((key) => ({ key, suggestion: byKey.get(key) ?? null }))
  }

  /**
   * The review's questions (`curate/questions.ts`): the suggestions on offer
   * grouped as a curator decides them, in the queue's order. Counted once per
   * answer and per what was turned down.
   */
  queue(): Question[] {
    const answer = this.answerHeld
    if (answer === null) return []
    const rejected = this.store.learned.rejected.join('\n')
    if (this.queueHeld?.answer === answer && this.queueHeld.rejected === rejected) return this.queueHeld.list
    const list = questions(this.offered(), answer, this.store.file.names).sort(queueOrder)
    this.queueHeld = { answer, rejected, list }
    return list
  }

  /**
   * The question in review: the one chosen if it is still asked (by its key, or
   * a member's), else the first; `null` while a step is counted — the queue is
   * then the binning's before it, which still holds a question just taken, and
   * a second Y would take it twice.
   */
  get currentQuestion(): Question | null {
    if (this.modeHeld !== 'review' || this.staleHeld) return null
    return this.questionOf(this.currentKey) ?? this.queue()[0] ?? null
  }

  /** The question of the queue with this key, or with a member of this key. */
  private questionOf(key: string | null): Question | undefined {
    if (key === null) return undefined
    const list = this.queue()
    return list.find((q) => q.key === key) ?? list.find((q) => q.members.some((m) => m.key === key))
  }

  /**
   * What review answers now: the current question, or the one member of it
   * the reader stepped into (↓).
   */
  get current(): Question | null {
    const question = this.currentQuestion
    const at = this.memberIndex(question)
    if (question === null || at < 0) return question
    const member = question.members[at]
    return { ...member, members: [member], steps: [member.step] }
  }

  /** Which member of the current question is answered alone, and of how many; `null` for the whole. */
  get member(): { at: number; of: number } | null {
    const question = this.currentQuestion
    const at = this.memberIndex(question)
    return question === null || at < 0 ? null : { at, of: question.members.length }
  }

  /** Where the member stepped into is in a question: `-1` for the whole, or a member it no longer has. */
  private memberIndex(question: Question | null): number {
    if (question === null || this.memberKey === null || question.members.length < 2) return -1
    return question.members.findIndex((m) => m.key === this.memberKey)
  }

  /** Review the question with this key, whole. */
  setCurrent(key: string): void {
    const next = this.questionOf(key)?.key ?? key
    if (next === this.currentKey && this.memberKey === null) return
    this.currentKey = next
    this.memberKey = null
    this.emit('current')
  }

  /** The next question in review, or the previous one; wraps. Nothing while a step is counted. */
  moveCurrent(by: 1 | -1): void {
    const question = this.currentQuestion
    if (question === null) return
    const list = this.queue()
    const at = Math.max(0, list.indexOf(question))
    this.currentKey = list[(at + by + list.length) % list.length].key
    this.memberKey = null
    this.emit('current')
  }

  /** Into the current question's members (↓), to the next one, or back out of them (↑ from the first). */
  moveMember(by: 1 | -1): boolean {
    const question = this.currentQuestion
    if (question === null || question.members.length < 2) return false
    const at = this.memberIndex(question)
    if (at < 0) {
      if (by < 0) return false
      this.memberKey = question.members[0].key
    } else {
      const next = at + by
      this.memberKey = next < 0 ? null : question.members[Math.min(next, question.members.length - 1)].key
    }
    // The question by its own key from here, whatever key brought it.
    this.currentKey = question.key
    this.emit('current')
    return true
  }

  /**
   * In review, where an answer leaves the reader: a member answered alone
   * leaves the rest of its question; a question answered whole, the next one
   * along — chosen before the answer changes the queue.
   */
  private moveOnFrom(answered: ReadonlySet<string>): void {
    if (this.modeHeld !== 'review') return
    const list = this.queue()
    const question = this.questionOf(this.currentKey) ?? list[0]
    // A suggestion answered from its card, not the one in review: review stays.
    if (question === undefined || !question.members.some((m) => answered.has(m.key))) return
    const at = this.memberIndex(question)
    const left = question.members.filter((m) => !answered.has(m.key))
    if (at >= 0 && left.length > 0) {
      // By a member's key: the question regroups once the answer is counted.
      const next = left[Math.min(at, left.length - 1)]
      this.currentKey = next.key
      this.memberKey = left.length > 1 ? next.key : null
      return
    }
    const k = list.indexOf(question)
    this.currentKey = list[k + 1]?.key ?? list[k - 1]?.key ?? null
    this.memberKey = null
  }

  /**
   * Take a suggestion, or a question whole: its steps, one gesture marked as
   * the suggestion's, and every member's answer learned.
   */
  accept(suggestion: Suggestion | Question, by: 'suggestion' | 'auto' = 'suggestion'): void {
    const members = 'members' in suggestion ? suggestion.members : [suggestion]
    const steps = 'steps' in suggestion ? suggestion.steps : [suggestion.step]
    let learned = this.store.learned
    for (const member of members) learned = this.learnedFrom(member, true, learned)
    const said = describeSuggestion(suggestion)
    this.moveOnFrom(new Set(members.map((member) => member.key)))
    if (steps.length === 1) this.store.apply(steps[0], by, said)
    else this.store.applyAll(steps.map((step) => ({ step, by, suggestion: said })))
    this.store.keepLearned(learned)
  }

  /** Turn a suggestion down, or a question's every member: none is offered again, and each answer is learned. */
  reject(suggestion: Suggestion | Question): void {
    const members = 'members' in suggestion ? suggestion.members : [suggestion]
    let learned = this.store.learned
    for (const member of members) {
      learned = this.learnedFrom(member, false, learned)
      if (!learned.rejected.includes(member.key)) learned = { ...learned, rejected: [...learned.rejected, member.key] }
    }
    this.moveOnFrom(new Set(members.map((member) => member.key)))
    this.store.keepLearned(learned)
  }

  /** Offer a suggestion turned down again. */
  restore(key: string): void {
    const learned = this.store.learned
    if (!learned.rejected.includes(key)) return
    this.store.keepLearned({ ...learned, rejected: learned.rejected.filter((k) => k !== key) })
  }

  /** Forget what the answers taught: the initial weights, nothing turned down. */
  forgetLearned(): void {
    this.store.keepLearned({ weights: {}, answers: 0, rejected: [] })
  }

  /** How many answers taught the weights. */
  get answers(): number {
    return this.store.learned.answers
  }

  private learnedFrom(suggestion: Suggestion, accepted: boolean, learned: CurationLearned = this.store.learned): CurationLearned {
    // An unlink is a link's confidence the other way round: taking one says the
    // link was wrong.
    const kind: LearnedKind = suggestion.kind === 'unlink' ? 'link' : suggestion.kind
    const yes = suggestion.kind === 'unlink' ? !accepted : accepted
    const weights = learned.weights[kind] ?? INITIAL_WEIGHTS[kind]
    return {
      weights: { ...learned.weights, [kind]: learn(kind, weights, suggestion.features, yes) },
      answers: learned.answers + 1,
      rejected: [...learned.rejected],
    }
  }

  /** Whether auto is taking suggestions. */
  get running(): boolean {
    return this.autoRun !== null
  }

  /** What the last auto run held back, and why: a step that would have lowered a genome's grade. */
  get heldBack(): ReadonlyArray<{ key: string; words: string; why: string }> {
    return this.heldBackList
  }

  private heldBackList: Array<{ key: string; words: string; why: string }> = []

  /**
   * Take every question at {@link AUTO_THRESHOLD} or more, in the queue's
   * order, one gesture each, counting again between two — what one takes
   * changes what the next is. A step that would lower a MAG's grade is held
   * back, and named ({@link heldBack}): a bulk answer never makes a genome
   * worse unseen. Stops when none is left, at {@link AUTO_MOST} steps, or when
   * stopped; never asks one question twice.
   *
   * @returns The steps it made.
   */
  async runAuto(most = AUTO_MOST): Promise<number> {
    if (this.autoRun !== null) return 0
    const run = { stopped: false }
    this.autoRun = run
    this.heldBackList = []
    this.emit('mode')
    const asked = new Set<string>()
    let steps = 0
    try {
      while (!run.stopped && steps < most) {
        await this.settled()
        if (run.stopped || this.disposed || this.errorHeld !== null) break
        const next = this.queue().find((q) => q.confidence >= AUTO_THRESHOLD && !asked.has(q.key))
        if (next === undefined) break
        asked.add(next.key)
        const priced = this.store.curation
        const why = await this.demotes(next)
        if (run.stopped || this.disposed) break
        // A step made while it was priced — a card's act — and it is asked
        // again on the binning as it now is; one turned down meanwhile, never.
        if (this.store.curation !== priced || this.staleHeld) {
          asked.delete(next.key)
          continue
        }
        const rejected = new Set(this.store.learned.rejected)
        if (next.members.some((member) => rejected.has(member.key))) continue
        if (why !== null) {
          this.heldBackList = [...this.heldBackList, { key: next.key, words: next.words, why }]
          continue
        }
        this.accept(next, 'auto')
        steps++
      }
    } finally {
      if (this.autoRun === run) this.autoRun = null
      if (!this.disposed) this.emit('mode')
    }
    return steps
  }

  /**
   * Why taking a question would lower a MAG's grade, or `null`: its steps
   * together, counted as a preview is, apart from it.
   */
  private async demotes(question: Question): Promise<string | null> {
    const before = this.answerHeld
    if (before === null) return null
    // A link moves no contig: no genome's markers change.
    if (question.steps.every((step) => step.op === 'link' || step.op === 'unlink' || step.op === 'rename')) return null
    const after = await this.client.state(withSteps(this.store.curation, question.steps, 'auto'), this.weights).promise.catch(() => null)
    if (after === null) return null
    const worse = priceOf(before, after).find((row) => priceVerdict(row) === 'demoted')
    if (worse === undefined) return null
    return `it would make ${worse.name} ${worse.gradeAfter === 'contaminated' ? 'contaminated' : `${worse.gradeAfter ?? 'ungraded'} quality`}`
  }

  /** Stop an auto run after the step it is making. */
  stopAuto(): void {
    if (this.autoRun !== null) this.autoRun.stopped = true
  }

  // -------------------------------------------------------------------------
  // Acts: each one step, made by the reader.
  // -------------------------------------------------------------------------

  private genome(id: string): CurationStateResult['genomes'][number] | undefined {
    return this.answerHeld?.genomes.find((genome) => genome.id === id)
  }

  private namesOf(contigs: readonly number[]): string[] {
    const names = this.store.file.names
    return contigs.map((c) => names[c]).filter((name): name is string => name !== undefined)
  }

  /**
   * Move the selected contigs to a genome, or to the pool (`null`): those not
   * there already — `false`, and no step, when none would move.
   */
  moveSelected(to: string | null): boolean {
    const contigs = this.selectionHeld.contigs
    if (contigs.length === 0) return false
    if (to !== null && this.genome(to) === undefined) return false
    // The binning as it stands, step just made included: the answer may lag.
    const binning = this.store.binning
    const target = to === null ? -1 : (binning.indexOfId(to) ?? -2)
    const moving = contigs.filter((c) => binning.genomeOf[c] !== target)
    if (moving.length === 0) return false
    this.store.apply({ op: 'move', contigs: this.namesOf(moving), to })
    this.selectionHeld = { genomes: to === null ? [] : [to], contigs }
    this.emit('selection')
    return true
  }

  /** Make a new genome of the selected contigs. */
  createFromSelected(kind: GenomeKind, name?: string): string | null {
    const contigs = this.selectionHeld.contigs
    if (contigs.length === 0) return null
    const minted = this.mint(kind)
    const wanted = name !== undefined && name.trim() !== '' ? name.trim() : minted.name
    this.store.apply({ op: 'create', id: minted.id, name: wanted, kind, contigs: this.namesOf(contigs) })
    this.selectionHeld = { genomes: [minted.id], contigs }
    this.emit('selection')
    return minted.id
  }

  /** A fresh id for a genome a step would create, and the name it would get. */
  mint(kind: GenomeKind): { id: string; name: string } {
    const id = this.mintId()
    return { id, name: `curated_${kind === 'mag' ? 'MAG' : 'element'}_${id.slice(MINTED.length)}` }
  }

  /** What dropping `dragged` on `target` would make (`curate/drop.ts`); `null` before the first count. */
  dropPlan(dragged: CurateDragged, target: CurateDropTarget): DropPlan | null {
    if (this.answerHeld === null) return null
    return dropPlan(dragged, target, this.answerHeld, this.store.file.names, (kind) => this.mint(kind))
  }

  /** Drop `dragged` on `target`: its steps made, the selection on what they leave. */
  drop(dragged: CurateDragged, target: CurateDropTarget): boolean {
    const plan = this.dropPlan(dragged, target)
    if (plan === null || plan.refused !== undefined) return false
    const steps = plan.steps
    if (steps.length === 1) this.store.apply(steps[0])
    else this.store.applyAll(steps.map((step) => ({ step })))
    const first = steps[0]
    let next: CurateSelection
    if (dragged.kind === 'contigs') {
      const genome = first.op === 'move' ? first.to : first.op === 'create' ? first.id : null
      next = { genomes: genome === null ? [] : [genome], contigs: [...dragged.contigs] }
    } else if (first.op === 'merge') next = { genomes: [first.into], contigs: [] }
    else if (first.op === 'dissolve') next = { genomes: [], contigs: [] }
    else next = { genomes: [...dragged.ids], contigs: [] }
    this.select(next)
    return true
  }

  /**
   * Merge the selected genomes into the longest of them, which keeps its name:
   * MAGs or elements, one kind at a time (`false` for both, as the drop
   * refuses them).
   */
  mergeSelected(into?: string): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => this.genome(id) !== undefined)
    if (ids.length < 2) return false
    if (new Set(ids.map((id) => this.genome(id)?.kind)).size > 1) return false
    const survivor = into !== undefined && ids.includes(into) ? into : [...ids].sort((a, b) => (this.genome(b)?.length ?? 0) - (this.genome(a)?.length ?? 0))[0]
    this.store.apply({ op: 'merge', into: survivor, genomes: ids.filter((id) => id !== survivor) })
    this.selectionHeld = { genomes: [survivor], contigs: [] }
    this.emit('selection')
    return true
  }

  /** Send the selected genomes' contigs to the pool. */
  dissolveSelected(): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => this.genome(id) !== undefined)
    if (ids.length === 0) return false
    this.store.applyAll(ids.map((genome) => ({ step: { op: 'dissolve', genome } as CurationStep })))
    this.selectionHeld = { genomes: [], contigs: [] }
    this.emit('selection')
    return true
  }

  /** Rename a genome; refused, with the reason, for a name {@link nameRefusal} refuses. */
  rename(id: string, name: string): string | null {
    const wanted = name.trim()
    this.contigNames ??= new Set(this.store.file.names)
    // Every live genome's name, an emptied one's too: the fold keeps them taken.
    const binning = this.store.binning
    const own = binning.nameOfId(id)
    const refused = nameRefusal(wanted, [...binning.takenNames].filter((taken) => taken !== own), this.contigNames)
    if (refused !== null) return refused
    if (this.genome(id)?.name === wanted) return null
    this.store.apply({ op: 'rename', genome: id, name: wanted })
    return null
  }

  /** Make the selected genomes MAGs, or elements. */
  retypeSelected(kind: GenomeKind): boolean {
    const ids = this.selectionHeld.genomes.filter((id) => {
      const genome = this.genome(id)
      return genome !== undefined && genome.kind !== kind
    })
    if (ids.length === 0) return false
    this.store.applyAll(ids.map((genome) => ({ step: { op: 'retype', genome, kind } as CurationStep })))
    return true
  }

  /** Link an element to a MAG, or undo a link. */
  link(element: string, mag: string, on: boolean): boolean {
    const e = this.genome(element)
    const m = this.genome(mag)
    if (e?.kind !== 'element' || m?.kind !== 'mag') return false
    const linked = this.answerHeld?.links.some((link) => link.element === element && link.mag === mag) ?? false
    if (linked === on) return false
    this.store.apply(on ? { op: 'link', element, mag } : { op: 'unlink', element, mag })
    return true
  }

  /** Undo the last step; an auto run stops first, as the reader has taken the binning back. */
  undo(): void {
    this.stopAuto()
    this.store.undo()
  }

  redo(): void {
    this.stopAuto()
    this.store.redo()
  }

  goTo(count: number): void {
    this.stopAuto()
    this.store.goTo(count)
  }

  /**
   * A fresh id for a genome a step creates, never one used before: past every
   * `curated:N` a step made — undone and dropped ones too, as far as the
   * suggestions turned down remember them, since a key turned down for the
   * old genome must not hold for a new one — and no genome's name of the file.
   */
  private mintId(): string {
    const taken = new Set(this.store.file.genomes.map((genome) => genome.name))
    let most = 0
    const seen = (text: string): void => {
      for (const found of text.matchAll(MINTED_ID)) most = Math.max(most, Number(found[1]))
    }
    for (const entry of this.store.curation.history) if (entry.step.op === 'create') seen(entry.step.id)
    for (const key of this.store.learned.rejected) seen(key)
    for (let n = most + 1; ; n++) if (!taken.has(`${MINTED}${n}`)) return `${MINTED}${n}`
  }

  // -------------------------------------------------------------------------
  // The tally.
  // -------------------------------------------------------------------------

  /** What the curation changed since the file, for the stage's running tally. */
  tally(): CurateTally | null {
    const answer = this.answerHeld
    if (answer === null) return null
    const file = this.store.file
    let contigsMoved = 0
    let basesMoved = 0
    answer.genomeOf.forEach((g, c) => {
      const now = g < 0 ? null : answer.genomes[g].id
      const was = file.genomeOf[c] < 0 ? null : file.genomes[file.genomeOf[c]].name
      if (now !== was) {
        contigsMoved++
        basesMoved += file.lengths[c] ?? 0
      }
    })
    const fileIds = new Set(file.genomes.map((genome) => genome.name))
    const liveIds = new Set(answer.genomes.map((genome) => genome.id))
    const fileLinks = new Set(file.links.map((link) => `${link.element}\t${link.mag}`))
    const liveLinks = new Set(answer.links.map((link) => `${link.element}\t${link.mag}`))
    return {
      steps: this.store.applied,
      contigsMoved,
      basesMoved,
      asInFile: answer.genomes.filter((genome) => genome.asInFile).length,
      changed: answer.genomes.filter((genome) => !genome.asInFile && fileIds.has(genome.id)).length,
      created: answer.genomes.filter((genome) => !fileIds.has(genome.id)).length,
      gone: [...fileIds].filter((id) => !liveIds.has(id)).length,
      linksAdded: [...liveLinks].filter((key) => !fileLinks.has(key)).length,
      linksDropped: [...fileLinks].filter((key) => !liveLinks.has(key)).length,
    }
  }
}

/**
 * Why a genome cannot have this name, or `null`: metacooler takes ASCII names
 * only, metaTOR's host lists split on commas, and a word a table means *no
 * genome* by (`NA`, `nan`, `-1`, `__unbinned__`, …, in any case) would be read
 * by `metacooler reassign` as the pool.
 */
export function nameRefusal(name: string, others: readonly string[], contigs?: ReadonlySet<string>): string | null {
  if (name === '') return 'A genome needs a name.'
  if (UNBINNED_WORDS.has(name.toLowerCase())) return `${name} is how a table says unbinned: metacooler would read this genome as none.`
  if (/[^\x21-\x7e]/.test(name)) return 'Names go to metacooler, which takes ASCII letters, digits and signs, without spaces.'
  if (name.includes(',')) return 'A name holds no comma: metaTOR lists genomes with them.'
  if (name.includes(':')) return 'A name holds no colon: a locus box would read it as a place.'
  if (others.includes(name)) return `Another genome is named ${name}.`
  if (contigs?.has(name) === true) return `A contig is named ${name}: the genome would hide it in every box that finds a place.`
  return null
}


/** Where each kind is answered in the queue: what changes the most first. */
const KIND_RANK: Record<Suggestion['kind'], number> = { merge: 0, move: 1, recruit: 2, link: 3, unlink: 3 }

/** The queue's order (see {@link CurateModel.offered}). */
export function queueOrder(a: Suggestion, b: Suggestion): number {
  const likelyA = a.confidence >= LIKELY ? 0 : 1
  const likelyB = b.confidence >= LIKELY ? 0 : 1
  return likelyA - likelyB || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.confidence - a.confidence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

/** A suggestion as the history keeps it: its words, its confidence, what it rested on. */
export function describeSuggestion(suggestion: Suggestion): string {
  const parts = [suggestion.words, `${displayPercent(suggestion.confidence)}%`, ...suggestion.evidence]
  return parts.join(' · ')
}

/** A confidence as a whole percent, never 100 — no suggestion is certain. */
export function displayPercent(confidence: number): number {
  return Math.min(99, Math.max(0, Math.round(confidence * 100)))
}

/** Whether a preview is a list of steps rather than one. */
function isStepList(what: CurationStep | readonly CurationStep[]): what is readonly CurationStep[] {
  return Array.isArray(what)
}

/** A curation with these steps made after it, as one gesture would make them. */
function withSteps(curation: Curation, steps: readonly CurationStep[], by: 'reader' | 'auto'): Curation {
  let next = curation
  for (const step of steps) next = withCurationStep(next, step, by, 0)
  return next
}

function combine<T>(now: readonly T[], given: readonly T[], how: SelectHow): T[] {
  if (how === 'replace') return [...new Set(given)]
  const out = [...now]
  const present = new Set(now)
  for (const item of given) {
    if (present.has(item)) {
      if (how === 'toggle') {
        const at = out.indexOf(item)
        if (at >= 0) out.splice(at, 1)
        present.delete(item)
      }
    } else {
      out.push(item)
      present.add(item)
    }
  }
  return out
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, k) => item === b[k])
}
